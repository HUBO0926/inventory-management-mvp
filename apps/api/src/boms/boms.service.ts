import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DataSource, QueryRunner } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { BusinessException } from '../common/business.exception';
import { parsePage } from '../common/validation';

@Injectable()
export class BomsService {
  constructor(private readonly db: DataSource, private readonly audit: AuditService) {}

  async list(q: any) {
    const page = parsePage(q.page, 1);
    const pageSize = parsePage(q.pageSize, 20, 100);
    const offset = (page - 1) * pageSize;
    const params: any[] = [];
    const where = ['b.deleted_at IS NULL'];
    if (q.keyword) {
      params.push(`%${q.keyword}%`);
      where.push(`(i.item_code ILIKE $${params.length} OR i.name ILIKE $${params.length})`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`b.status=$${params.length}`);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const [{ count }] = await this.db.query(
      `SELECT count(*)::int count FROM boms b JOIN items i ON i.id=b.finished_good_id ${clause}`,
      params,
    );
    params.push(pageSize, offset);
    const rows = await this.db.query(
      `SELECT b.id,b.version,b.status,b.notes,i.id "finishedGoodId",
        i.item_code "finishedGoodCode",i.name "finishedGoodName",i.item_type "outputItemType",
        count(bi.id)::int "lineCount",b.created_at "createdAt",b.updated_at "updatedAt"
       FROM boms b JOIN items i ON i.id=b.finished_good_id
       LEFT JOIN bom_items bi ON bi.bom_id=b.id
       ${clause}
       GROUP BY b.id,i.id ORDER BY b.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows, total: count, page, pageSize };
  }

  async get(id: string) {
    const [bom] = await this.db.query(
      `SELECT b.id,b.version,b.status,b.notes,i.id "finishedGoodId",
        i.item_code "finishedGoodCode",i.name "finishedGoodName",i.item_type "outputItemType"
       FROM boms b JOIN items i ON i.id=b.finished_good_id
       WHERE b.id=$1 AND b.deleted_at IS NULL`,
      [id],
    );
    if (!bom) throw new BusinessException('NOT_FOUND', 'BOM 不存在');
    bom.lines = await this.db.query(
      `SELECT bi.material_id "materialId",i.item_code "itemCode",i.name,i.item_type "itemType",
        i.unit,bi.qty_per "qtyPer"
       FROM bom_items bi JOIN items i ON i.id=bi.material_id
       WHERE bi.bom_id=$1 ORDER BY i.item_code`,
      [id],
    );
    return bom;
  }

  async save(id: string | null, dto: any, userId: string) {
    if (!dto.lines?.length) throw new BusinessException('VALIDATION_ERROR', 'BOM 至少包含一条组成物料');
    if (dto.lines.some((line: any) => line.materialId === dto.finishedGoodId)) {
      throw new BusinessException('VALIDATION_ERROR', 'BOM 产出物料不能包含自身');
    }
    if (new Set(dto.lines.map((line: any) => line.materialId)).size !== dto.lines.length) {
      throw new BusinessException('VALIDATION_ERROR', 'BOM 组成物料不能重复');
    }
    if (dto.lines.some((line: any) => !new Decimal(line.qtyPer).isPositive())) {
      throw new BusinessException('VALIDATION_ERROR', 'BOM 单件用量必须大于零');
    }

    const qr = this.db.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const [output] = await qr.query(
        `SELECT id,item_type FROM items
         WHERE id=$1 AND item_type='FINISHED_GOOD'
           AND status='ACTIVE' AND deleted_at IS NULL`,
        [dto.finishedGoodId],
      );
      if (!output) throw new BusinessException('VALIDATION_ERROR', '产出物料必须是启用的半成品或成品');

      const materialIds = dto.lines.map((line: any) => line.materialId);
      const materialRows = await qr.query(
        `SELECT id,item_type FROM items
         WHERE id=ANY($1::uuid[]) AND item_type='MATERIAL'
           AND status='ACTIVE' AND deleted_at IS NULL`,
        [materialIds],
      );
      if (materialRows.length !== dto.lines.length) {
        throw new BusinessException('VALIDATION_ERROR', '组成物料只能选择启用的原材料或半成品');
      }
      await this.assertNoCycle(qr, dto.finishedGoodId, materialRows, id);

      let bomId = id;
      if (id) {
        const [existing] = await qr.query(
          `SELECT id FROM boms WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [id],
        );
        if (!existing) throw new BusinessException('NOT_FOUND', 'BOM 不存在');
        await qr.query(
          `UPDATE boms SET finished_good_id=$1,version=$2,status=$3,notes=$4,updated_at=now()
           WHERE id=$5`,
          [dto.finishedGoodId, dto.version.trim(), dto.status, dto.notes || null, id],
        );
        await qr.query(`DELETE FROM bom_items WHERE bom_id=$1`, [id]);
      } else {
        bomId = randomUUID();
        await qr.query(
          `INSERT INTO boms(id,finished_good_id,version,status,notes)
           VALUES($1,$2,$3,$4,$5)`,
          [bomId, dto.finishedGoodId, dto.version.trim(), dto.status, dto.notes || null],
        );
      }
      for (const line of dto.lines) {
        await qr.query(
          `INSERT INTO bom_items(id,bom_id,material_id,qty_per) VALUES($1,$2,$3,$4)`,
          [randomUUID(), bomId, line.materialId, new Decimal(line.qtyPer).toFixed(4)],
        );
      }
      await this.audit.log(userId, id ? 'UPDATE_BOM' : 'CREATE_BOM', 'boms', bomId!, dto, qr.manager);
      await qr.commitTransaction();
      return this.get(bomId!);
    } catch (error: any) {
      await qr.rollbackTransaction();
      if (error.code === '23505') {
        throw new BusinessException(
          'DUPLICATE_CODE',
          '同一产出物料已有相同版本，或已有其他启用 BOM',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    } finally {
      await qr.release();
    }
  }

  async copy(id: string, dto: any, userId: string) {
    const source = await this.get(id);
    return this.save(null, {
      finishedGoodId: source.finishedGoodId,
      version: dto.version,
      status: dto.status || 'INACTIVE',
      notes: source.notes,
      lines: source.lines.map((line: any) => ({ materialId: line.materialId, qtyPer: line.qtyPer })),
    }, userId);
  }

  async changeStatus(id: string, status: string, userId: string) {
    const source = await this.get(id);
    return this.save(id, {
      finishedGoodId: source.finishedGoodId,
      version: source.version,
      status,
      notes: source.notes,
      lines: source.lines.map((line: any) => ({ materialId: line.materialId, qtyPer: line.qtyPer })),
    }, userId);
  }

  async remove(id: string, userId: string) {
    const [row] = await this.db.query(
      `UPDATE boms SET deleted_at=now(),status='INACTIVE',updated_at=now()
       WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [id],
    );
    if (!row) throw new BusinessException('NOT_FOUND', 'BOM 不存在');
    await this.audit.log(userId, 'DELETE_BOM', 'boms', id, { deletionMode: 'ARCHIVED' });
    return { id, deletionMode: 'ARCHIVED' };
  }

  private async assertNoCycle(
    qr: QueryRunner,
    outputId: string,
    materials: Array<{ id: string; item_type: string }>,
    currentBomId: string | null,
  ) {
    const semiFinishedIds = materials
      .filter(row => row.item_type === 'SEMI_FINISHED')
      .map(row => row.id);
    if (!semiFinishedIds.length) return;
    const [cycle] = await qr.query(
      `WITH RECURSIVE graph(parent_id,child_id) AS (
         SELECT b.finished_good_id,bi.material_id
         FROM boms b JOIN bom_items bi ON bi.bom_id=b.id
         JOIN items component ON component.id=bi.material_id
         WHERE b.deleted_at IS NULL AND component.item_type='SEMI_FINISHED'
           AND ($3::uuid IS NULL OR b.id<>$3)
       ), reachable(node) AS (
         SELECT unnest($2::uuid[])
         UNION
         SELECT g.child_id FROM reachable r JOIN graph g ON g.parent_id=r.node
       )
       SELECT 1 FROM reachable WHERE node=$1 LIMIT 1`,
      [outputId, semiFinishedIds, currentBomId],
    );
    if (cycle) throw new BusinessException('BOM_CYCLE', '半成品 BOM 不能形成循环依赖', HttpStatus.CONFLICT);
  }
}
