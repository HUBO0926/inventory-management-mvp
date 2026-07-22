import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { BusinessException } from '../common/business.exception';
import { parsePage } from '../common/validation';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ItemsService {
  constructor(private readonly db: DataSource, private readonly audit: AuditService) {}
  async list(query: any) {
    const page = parsePage(query.page, 1); const pageSize = parsePage(query.pageSize, 20, 100); const offset = (page - 1) * pageSize;
    const params: any[] = []; const where: string[] = [];
    if (query.keyword) { params.push(`%${query.keyword}%`); where.push(`(item_code ILIKE $${params.length} OR name ILIKE $${params.length})`); }
    if (query.status) { params.push(query.status); where.push(`status=$${params.length}`); }
    if (query.itemType) { params.push(query.itemType); where.push(`item_type=$${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ count }] = await this.db.query(`SELECT count(*)::int count FROM items ${clause}`, params);
    params.push(pageSize, offset);
    const rows = await this.db.query(`SELECT id,item_code "itemCode",name,item_type "itemType",unit,minimum_stock "minimumStock",status,created_at "createdAt" FROM items ${clause} ORDER BY item_code LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows, total: count, page, pageSize };
  }
  async get(id: string) {
    const [row] = await this.db.query(`SELECT id,item_code "itemCode",name,item_type "itemType",unit,minimum_stock "minimumStock",status FROM items WHERE id=$1`, [id]);
    if (!row) throw new BusinessException('NOT_FOUND', '物料不存在'); return row;
  }
  async create(dto: any, userId: string) {
    try {
      const [row] = await this.db.query(`INSERT INTO items(id,item_code,name,item_type,unit,minimum_stock) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,item_code "itemCode",name,item_type "itemType",unit,minimum_stock "minimumStock",status`, [randomUUID(), dto.itemCode.trim(), dto.name.trim(), dto.itemType, dto.unit.trim(), dto.minimumStock || '0']);
      await this.audit.log(userId, 'CREATE_ITEM', 'items', row.id, dto); return row;
    } catch (e: any) { if (e.code === '23505') throw new BusinessException('DUPLICATE_CODE', '物料编码已存在'); throw e; }
  }
  async update(id: string, dto: any, userId: string) {
    const fields: string[] = []; const params: any[] = [];
    for (const [key, col] of Object.entries({ name: 'name', unit: 'unit', minimumStock: 'minimum_stock', status: 'status' })) {
      if (dto[key] !== undefined) { params.push(dto[key]); fields.push(`${col}=$${params.length}`); }
    }
    if (!fields.length) return this.get(id); params.push(id);
    const [row] = await this.db.query(`UPDATE items SET ${fields.join(',')},updated_at=now() WHERE id=$${params.length} RETURNING id,item_code "itemCode",name,item_type "itemType",unit,minimum_stock "minimumStock",status`, params);
    if (!row) throw new BusinessException('NOT_FOUND', '物料不存在');
    await this.audit.log(userId, 'UPDATE_ITEM', 'items', id, dto); return row;
  }
}
