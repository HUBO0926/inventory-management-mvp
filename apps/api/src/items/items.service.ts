import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import sharp, { Metadata, OutputInfo } from 'sharp';
import { BusinessException } from '../common/business.exception';
import { parsePage } from '../common/validation';
import { AuditService } from '../audit/audit.service';
import { AuthUser, EntityStatus, ItemType, Role } from '../common/constants';
import { snapshotUser } from '../common/snapshot';
import { CreateItemDto, ItemQueryDto, UpdateItemDto } from './items.dto';

@Injectable()
export class ItemsService {
  constructor(private readonly db: DataSource, private readonly audit: AuditService) {}

  async list(query: ItemQueryDto) {
    const page = parsePage(query.page, 1); const pageSize = parsePage(query.pageSize, 20, 100); const offset = (page - 1) * pageSize;
    const params: any[] = []; const where: string[] = ['i.deleted_at IS NULL'];
    if (query.keyword) { params.push(`%${query.keyword}%`); where.push(`(i.item_code ILIKE $${params.length} OR i.name ILIKE $${params.length})`); }
    if (query.status) { params.push(query.status); where.push(`i.status=$${params.length}`); }
    const itemType = this.resolveQueryType(query);
    if (itemType) { params.push(itemType); where.push(`i.item_type=$${params.length}`); }
    if (query.categoryId) { params.push(query.categoryId); where.push(`i.category_id=$${params.length}`); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const [{ count }] = await this.db.query(`SELECT count(*)::int count FROM items i ${clause}`, params);
    params.push(pageSize, offset);
    const rows = await this.db.query(
      `SELECT i.id,i.item_code "itemCode",i.name,i.item_type "itemType",i.unit,i.unit_id "unitId",
        u.name "unitName",i.category_id "categoryId",c.name "categoryName",
        i.minimum_stock "minimumStock",i.brand,i.model,i.spec,i.enable_batch "enableBatch",
        i.default_warehouse_id "defaultWarehouseId",i.status,i.remark,
        i.image_url "imageUrl",i.thumbnail_url "thumbnailUrl",
        i.image_size::int "imageSize",i.image_width "imageWidth",i.image_height "imageHeight",
        i.image_mime_type "imageMimeType",
        i.created_by_name "createdByName",i.updated_by_name "updatedByName",
        i.created_at "createdAt",i.updated_at "updatedAt",
        COALESCE(sb.on_hand_qty,0) "onHandQty"
       FROM items i JOIN units u ON u.id=i.unit_id LEFT JOIN item_categories c ON c.id=i.category_id
       LEFT JOIN (SELECT item_id,sum(on_hand_qty) on_hand_qty FROM stock_balances GROUP BY item_id) sb ON sb.item_id=i.id
       ${clause.replace(/i\.status/g,'i.status').replace(/i\.item_type/g,'i.item_type')}
       ORDER BY i.item_code LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows, total: count, page, pageSize };
  }

  async get(id: string) {
    const [row] = await this.db.query(
      `SELECT i.id,i.item_code "itemCode",i.name,i.item_type "itemType",i.unit,i.unit_id "unitId",
        u.name "unitName",i.category_id "categoryId",c.name "categoryName",
        i.minimum_stock "minimumStock",i.brand,i.model,i.spec,i.enable_batch "enableBatch",
        i.default_warehouse_id "defaultWarehouseId",i.status,i.remark,
        i.image_url "imageUrl",i.thumbnail_url "thumbnailUrl",
        i.image_size::int "imageSize",i.image_width "imageWidth",i.image_height "imageHeight",
        i.image_mime_type "imageMimeType",
        i.created_by_name "createdByName",i.updated_by_name "updatedByName",
        i.created_at "createdAt",i.updated_at "updatedAt",
        COALESCE(sb.on_hand_qty,0) "onHandQty"
       FROM items i JOIN units u ON u.id=i.unit_id LEFT JOIN item_categories c ON c.id=i.category_id
       LEFT JOIN (SELECT item_id,sum(on_hand_qty) on_hand_qty FROM stock_balances GROUP BY item_id) sb ON sb.item_id=i.id
       WHERE i.id=$1 AND i.deleted_at IS NULL`,
      [id],
    );
    if (!row) throw new BusinessException('NOT_FOUND', '物料不存在');
    const refs = await this.references(id);
    row.references = refs;
    const typeRules = await this.itemTypeRules(id);
    row.canEditIdentity = true;
    row.canEditCode = true;
    row.canEditType = true;
    row.canEditUnit = true;
    row.allowedItemTypes = typeRules.allowedTypes;
    row.typeRestrictions = typeRules.reasons;
    return row;
  }

  async create(input: CreateItemDto, user: AuthUser) {
    const dto = this.normalizeAliases(input, false);
    try {
      const unit = await this.resolveUnitForCreate(dto.unitId, dto.unit);
      const category = await this.resolveCategory(dto.categoryId, dto.category, dto.itemType);
      if (!unit) throw new BusinessException('VALIDATION_ERROR', '计量单位不存在或已停用');
      if ((dto.categoryId || dto.category) && !category) {
        throw new BusinessException('VALIDATION_ERROR', '物料分类不存在、已停用或与物料类型不一致');
      }
      const snap = snapshotUser(user);
      const [row] = await this.db.query(
        `INSERT INTO items(id,item_code,name,item_type,unit,unit_id,category_id,minimum_stock,brand,model,spec,default_warehouse_id,enable_batch,status,remark,created_by_user_id,created_by_username,created_by_name,created_by_department)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id,item_code "itemCode",name,item_type "itemType",unit,unit_id "unitId",category_id "categoryId",minimum_stock "minimumStock",brand,model,spec,enable_batch "enableBatch",status,remark`,
        [randomUUID(), dto.itemCode.trim(), dto.name.trim(), dto.itemType,
          unit.name, unit.id, category?.id || null, dto.minimumStock || '0',
          dto.brand || null, dto.model || null, dto.spec || null,
          dto.defaultWarehouseId || null, dto.enableBatch || false,
          dto.status || EntityStatus.ACTIVE, dto.remark || null,
          snap.userId, snap.username, snap.name, snap.department],
      );
      await this.audit.log(user.id, 'CREATE_ITEM', 'items', row.id, dto);
      return row;
    } catch (e: any) {
      if (e.code === '23505') throw new BusinessException('DUPLICATE_CODE', '物料编码已存在', HttpStatus.CONFLICT);
      throw e;
    }
  }

  async update(id: string, input: UpdateItemDto, user: AuthUser) {
    const current = await this.get(id);
    const dto = this.normalizeAliases(input, true);
    if (dto.unitId !== undefined || dto.unit !== undefined) {
      const unit = await this.resolveUnitForCreate(dto.unitId, dto.unit);
      if (!unit) throw new BusinessException('VALIDATION_ERROR', '单位不存在或已停用');
      dto.unitId = unit.id;
      dto.unit = unit.name;
    }
    const targetType = dto.itemType || current.itemType;
    if (dto.categoryId !== undefined || dto.category !== undefined) {
      const category = await this.resolveCategory(dto.categoryId, dto.category, targetType);
      if ((dto.categoryId || dto.category) && !category) {
        throw new BusinessException('VALIDATION_ERROR', '物料分类不存在、已停用或与物料类型不一致');
      }
      dto.categoryId = category?.id || null;
    } else if (targetType !== current.itemType) {
      dto.categoryId = null;
    }
    const identityChanged = (
      (dto.itemCode !== undefined && dto.itemCode !== current.itemCode)
      || (dto.itemType !== undefined && dto.itemType !== current.itemType)
      || (dto.unitId !== undefined && dto.unitId !== current.unitId)
    );
    if (identityChanged) {
      if (user.role !== Role.ADMIN && !user.permissions?.includes('item.identity.manage')) {
        throw new BusinessException('FORBIDDEN', '无权修改物料编码、类型或单位', HttpStatus.FORBIDDEN);
      }
    }
    if (dto.itemType !== undefined && dto.itemType !== current.itemType) {
      await this.validateItemTypeChange(id, dto.itemType);
    }
    const fields: string[] = []; const params: any[] = [];
    const map: Record<string, string> = {
      itemCode: 'item_code', itemType: 'item_type', name: 'name', unit: 'unit',
      unitId: 'unit_id', categoryId: 'category_id', minimumStock: 'minimum_stock',
      brand: 'brand', model: 'model', spec: 'spec',
      defaultWarehouseId: 'default_warehouse_id', enableBatch: 'enable_batch',
      status: 'status', remark: 'remark',
    };
    for (const [key, col] of Object.entries(map)) {
      if (dto[key] !== undefined) { params.push(dto[key]); fields.push(`${col}=$${params.length}`); }
    }
    if (!fields.length) return this.get(id);
    const snap = snapshotUser(user);
    params.push(snap.userId, snap.username, snap.name, snap.department, id);
    fields.push(`updated_by_user_id=$${params.length - 4}`);
    fields.push(`updated_by_username=$${params.length - 3}`);
    fields.push(`updated_by_name=$${params.length - 2}`);
    fields.push(`updated_by_department=$${params.length - 1}`);
    fields.push(`updated_at=now()`);
    const [row] = await this.db.query(
      `UPDATE items SET ${fields.join(',')} WHERE id=$${params.length} AND deleted_at IS NULL
       RETURNING id,item_code "itemCode",name,item_type "itemType",unit,unit_id "unitId",category_id "categoryId",minimum_stock "minimumStock",brand,model,spec,enable_batch "enableBatch",status`,
      params,
    );
    if (!row) throw new BusinessException('NOT_FOUND', '物料不存在');
    await this.audit.log(user.id, 'UPDATE_ITEM', 'items', id, dto);
    return row;
  }

  async remove(id: string, user: AuthUser) {
    const current = await this.get(id);
    const refs = await this.references(id);
    const referenced = Object.values(refs).some((n: any) => Number(n) > 0);
    if (referenced) {
      const [row] = await this.db.query(
        `UPDATE items SET deleted_at=now(),status='INACTIVE',updated_at=now()
         WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
        [id],
      );
      if (!row) throw new BusinessException('NOT_FOUND', '物料不存在');
      await this.audit.log(user.id, 'ARCHIVE_ITEM', 'items', id, { references: refs });
      return { id, deletionMode: 'ARCHIVED' };
    }
    const result = await this.db.query(`DELETE FROM items WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!result[1]) throw new BusinessException('NOT_FOUND', '物料不存在');
    await this.audit.log(user.id, 'DELETE_ITEM', 'items', id);
    await this.removeStoredImages(current.imageUrl, current.thumbnailUrl);
    return { id, deletionMode: 'HARD' };
  }

  async copy(id: string, newCode: string, user: AuthUser) {
    const original = await this.get(id);
    if (!original) throw new BusinessException('NOT_FOUND', '原物料不存在');
    return this.create({
      itemCode: newCode, name: original.name, itemType: original.itemType,
      unitId: original.unitId, categoryId: original.categoryId,
      minimumStock: original.minimumStock, brand: original.brand,
      model: original.model, spec: original.spec,
      defaultWarehouseId: original.defaultWarehouseId, enableBatch: original.enableBatch,
      remark: original.remark,
    }, user);
  }

  async uploadImage(id: string, file: Express.Multer.File | undefined, user: AuthUser) {
    if (!file?.buffer?.length) throw new BusinessException('VALIDATION_ERROR', '请选择要上传的图片');
    if (file.size > 10 * 1024 * 1024) throw new BusinessException('FILE_TOO_LARGE', '图片不能超过10MB', HttpStatus.PAYLOAD_TOO_LARGE);

    let metadata: Metadata;
    try {
      metadata = await sharp(file.buffer, { failOn: 'error' }).metadata();
    } catch {
      throw new BusinessException('INVALID_IMAGE', '图片文件损坏或格式不受支持');
    }
    if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
      throw new BusinessException('UNSUPPORTED_IMAGE_TYPE', '仅支持 JPG、PNG 和 WebP 图片');
    }

    const fileId = randomUUID();
    const imageDirectory = join(this.uploadRoot(), 'items');
    const imageName = `${fileId}.webp`;
    const thumbnailName = `${fileId}_thumb.webp`;
    const imagePath = join(imageDirectory, imageName);
    const thumbnailPath = join(imageDirectory, thumbnailName);
    await fs.mkdir(imageDirectory, { recursive: true });

    let imageInfo: OutputInfo;
    try {
      const imageResult = await sharp(file.buffer, { failOn: 'error' })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      const thumbnailBuffer = await sharp(file.buffer, { failOn: 'error' })
        .rotate()
        .resize({
          width: 300,
          height: 300,
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .webp({ quality: 75 })
        .toBuffer();
      imageInfo = imageResult.info;
      await Promise.all([
        fs.writeFile(imagePath, imageResult.data, { flag: 'wx' }),
        fs.writeFile(thumbnailPath, thumbnailBuffer, { flag: 'wx' }),
      ]);
    } catch (error) {
      await Promise.allSettled([fs.unlink(imagePath), fs.unlink(thumbnailPath)]);
      if (error instanceof BusinessException) throw error;
      throw new BusinessException('IMAGE_PROCESSING_FAILED', '图片处理失败，请更换图片后重试');
    }

    const imageUrl = `/uploads/items/${imageName}`;
    const thumbnailUrl = `/uploads/items/${thumbnailName}`;
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let previous: { image_url?: string; thumbnail_url?: string } | undefined;
    try {
      [previous] = await runner.query(
        `SELECT image_url,thumbnail_url FROM items WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [id],
      );
      if (!previous) throw new BusinessException('NOT_FOUND', '物料不存在', HttpStatus.NOT_FOUND);
      const snap = snapshotUser(user);
      await runner.query(
        `UPDATE items SET image_url=$1,thumbnail_url=$2,image_size=$3,image_width=$4,image_height=$5,
          image_mime_type='image/webp',updated_by_user_id=$6,updated_by_username=$7,updated_by_name=$8,
          updated_by_department=$9,updated_at=now() WHERE id=$10`,
        [imageUrl, thumbnailUrl, imageInfo.size, imageInfo.width, imageInfo.height,
          snap.userId, snap.username, snap.name, snap.department, id],
      );
      await this.audit.log(user.id, previous.image_url ? 'REPLACE_ITEM_IMAGE' : 'UPLOAD_ITEM_IMAGE', 'items', id, {
        imageUrl, thumbnailUrl, size: imageInfo.size, width: imageInfo.width, height: imageInfo.height,
      }, runner.manager);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      await Promise.allSettled([fs.unlink(imagePath), fs.unlink(thumbnailPath)]);
      throw error;
    } finally {
      await runner.release();
    }
    await this.removeStoredImages(previous?.image_url, previous?.thumbnail_url);
    return {
      imageUrl,
      thumbnailUrl,
      width: imageInfo.width,
      height: imageInfo.height,
      size: imageInfo.size,
      mimeType: 'image/webp',
    };
  }

  async deleteImage(id: string, user: AuthUser) {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let previous: { image_url?: string; thumbnail_url?: string } | undefined;
    try {
      [previous] = await runner.query(
        `SELECT image_url,thumbnail_url FROM items WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [id],
      );
      if (!previous) throw new BusinessException('NOT_FOUND', '物料不存在', HttpStatus.NOT_FOUND);
      const snap = snapshotUser(user);
      await runner.query(
        `UPDATE items SET image_url=NULL,thumbnail_url=NULL,image_size=NULL,image_width=NULL,image_height=NULL,
          image_mime_type=NULL,updated_by_user_id=$2,updated_by_username=$3,updated_by_name=$4,
          updated_by_department=$5,updated_at=now() WHERE id=$1`,
        [id, snap.userId, snap.username, snap.name, snap.department],
      );
      await this.audit.log(user.id, 'DELETE_ITEM_IMAGE', 'items', id, undefined, runner.manager);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
    await this.removeStoredImages(previous?.image_url, previous?.thumbnail_url);
    return { id, imageUrl: null, thumbnailUrl: null };
  }

  async parameters(materialId: string) {
    const rows = await this.db.query(
      `SELECT id,material_id "materialId",parameter_name "parameterName",parameter_value "parameterValue",unit,remark,sort_order "sortOrder"
       FROM material_parameters WHERE material_id=$1 ORDER BY sort_order`, [materialId],
    );
    return { items: rows };
  }

  async addParameter(materialId: string, dto: any, user: AuthUser) {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO material_parameters(id,material_id,parameter_name,parameter_value,unit,remark,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,COALESCE((SELECT max(sort_order)+1 FROM material_parameters WHERE material_id=$2),0))`,
      [id, materialId, dto.parameterName, dto.parameterValue, dto.unit || null, dto.remark || null],
    );
    await this.audit.log(user.id, 'ADD_PARAMETER', 'material_parameters', id, dto);
    return { id };
  }

  async updateParameter(materialId: string, paramId: string, dto: any, user: AuthUser) {
    await this.db.query(
      `UPDATE material_parameters SET parameter_name=$1,parameter_value=$2,unit=$3,remark=$4,updated_at=now() WHERE id=$5 AND material_id=$6`,
      [dto.parameterName, dto.parameterValue, dto.unit || null, dto.remark || null, paramId, materialId],
    );
    await this.audit.log(user.id, 'UPDATE_PARAMETER', 'material_parameters', paramId, dto);
    return { id: paramId };
  }

  async deleteParameter(materialId: string, paramId: string, user: AuthUser) {
    await this.db.query(`DELETE FROM material_parameters WHERE id=$1 AND material_id=$2`, [paramId, materialId]);
    await this.audit.log(user.id, 'DELETE_PARAMETER', 'material_parameters', paramId);
    return { id: paramId };
  }

  async sortParameters(materialId: string, ids: string[], user: AuthUser) {
    for (let i = 0; i < ids.length; i++) {
      await this.db.query(`UPDATE material_parameters SET sort_order=$1,updated_at=now() WHERE id=$2 AND material_id=$3`, [i, ids[i], materialId]);
    }
  }

  async timeline(materialId: string) {
    return this.db.query(
      `SELECT action,created_at,details FROM operation_logs WHERE entity_type='items' AND entity_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [materialId],
    );
  }

  private resolveQueryType(query: ItemQueryDto) {
    const alias = query.type ? this.normalizeType(query.type) : undefined;
    if (query.itemType && alias && query.itemType !== alias) {
      throw new BusinessException('VALIDATION_ERROR', 'itemType 与 type 参数不一致');
    }
    const resolved = query.itemType || alias;
    if (resolved === ItemType.SEMI_FINISHED) throw new BusinessException('VALIDATION_ERROR', '系统已下线半成品，不支持该物料类型');
    return resolved;
  }

  private normalizeType(type: string): ItemType {
    const normalized = type === 'RAW_MATERIAL' ? ItemType.MATERIAL : type as ItemType;
    if (!Object.values(ItemType).includes(normalized)) {
      throw new BusinessException('VALIDATION_ERROR', '物料类型不正确');
    }
    return normalized;
  }

  private normalizeAliases(input: CreateItemDto | UpdateItemDto, partial: boolean): any {
    const dto: any = { ...input };
    const merge = (canonical: string, alias: string, normalize: (value: any) => any = value => value) => {
      const canonicalValue = dto[canonical] === undefined ? undefined : normalize(dto[canonical]);
      const aliasValue = dto[alias] === undefined ? undefined : normalize(dto[alias]);
      if (canonicalValue !== undefined && aliasValue !== undefined && canonicalValue !== aliasValue) {
        throw new BusinessException('VALIDATION_ERROR', `${canonical} 与 ${alias} 字段内容不一致`);
      }
      if (canonicalValue !== undefined || aliasValue !== undefined) dto[canonical] = canonicalValue ?? aliasValue;
      delete dto[alias];
    };
    merge('itemCode', 'code', value => String(value).trim().toUpperCase());
    merge('itemType', 'type', value => this.normalizeType(String(value)));
    if (dto.itemType === ItemType.SEMI_FINISHED) throw new BusinessException('VALIDATION_ERROR', '系统已下线半成品，不支持该物料类型');
    merge('spec', 'specification', value => value === null ? null : String(value).trim());
    merge('minimumStock', 'safetyStock', value => String(value));
    merge('status', 'enabled', value => typeof value === 'boolean'
      ? value ? EntityStatus.ACTIVE : EntityStatus.INACTIVE
      : value);

    if (dto.itemCode !== undefined) {
      dto.itemCode = String(dto.itemCode).trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{0,49}$/.test(dto.itemCode)) {
        throw new BusinessException('VALIDATION_ERROR', '物料编码只能包含大写字母、数字和横线，最长50字符');
      }
    }
    if (dto.name !== undefined) dto.name = String(dto.name).trim();
    for (const field of ['brand', 'model', 'spec', 'remark']) {
      if (dto[field] !== undefined) dto[field] = dto[field] === null || String(dto[field]).trim() === '' ? null : String(dto[field]).trim();
    }
    if (!partial) {
      if (!dto.itemCode) throw new BusinessException('VALIDATION_ERROR', '物料编码不能为空');
      if (!dto.itemType) throw new BusinessException('VALIDATION_ERROR', '物料类型不能为空');
      if (!dto.unitId && !dto.unit) throw new BusinessException('VALIDATION_ERROR', '计量单位不能为空');
    }
    return dto;
  }

  private async resolveUnit(unitId?: string, unitName?: string) {
    if (unitId) {
      const [unit] = await this.db.query(`SELECT id,name FROM units WHERE id=$1 AND status='ACTIVE'`, [unitId]);
      return unit;
    }
    if (unitName) {
      const [unit] = await this.db.query(`SELECT id,name FROM units WHERE name=$1 AND status='ACTIVE'`, [unitName.trim()]);
      return unit;
    }
    return undefined;
  }

  private async resolveUnitForCreate(unitId?: string, unitName?: string) {
    const existing = await this.resolveUnit(unitId, unitName);
    if (existing || !unitName || unitId) return existing;
    const [created] = await this.db.query(
      `INSERT INTO units(code,name)
       VALUES(upper(substr(md5($1),1,12)),$1)
       ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name
       RETURNING id,name`,
      [unitName.trim()],
    );
    return created;
  }

  private async resolveCategory(categoryId: string | null | undefined, category: string | undefined, itemType: ItemType) {
    if (categoryId) {
      const [row] = await this.db.query(
        `SELECT id FROM item_categories WHERE id=$1 AND item_type=$2 AND status='ACTIVE'`,
        [categoryId,itemType],
      );
      return row;
    }
    if (category) {
      const [row] = await this.db.query(
        `SELECT id FROM item_categories
         WHERE item_type=$2 AND status='ACTIVE' AND (code=$1 OR name=$1)
         ORDER BY sort_order,code LIMIT 1`,
        [category.trim(),itemType],
      );
      return row;
    }
    return undefined;
  }

  private uploadRoot() {
    return process.env.UPLOAD_ROOT || '/app/uploads';
  }

  private async removeStoredImages(imageUrl?: string | null, thumbnailUrl?: string | null) {
    const directory = join(this.uploadRoot(), 'items');
    const paths = [imageUrl, thumbnailUrl]
      .filter((value): value is string => Boolean(value))
      .map(value => join(directory, basename(value)));
    await Promise.all(paths.map(filePath => this.removeFile(filePath)));
  }

  private async removeFile(filePath: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.unlink(filePath);
        return;
      } catch (error: any) {
        if (error?.code === 'ENOENT') return;
        if (!['EBUSY', 'EPERM'].includes(error?.code) || attempt === 4) return;
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  }

  private async references(id: string) {
    const [[bom], [documents], [balances], [transactions], [orders], [snapshots], [batches]] = await Promise.all([
      this.db.query(`SELECT (
        (SELECT count(*) FROM bom_items WHERE material_id=$1 OR alternative_material_id=$1)
        +(SELECT count(*) FROM boms WHERE finished_good_id=$1)
      )::int count`, [id]),
      this.db.query(`SELECT count(*)::int count FROM stock_document_lines WHERE item_id=$1`, [id]),
      this.db.query(`SELECT count(*)::int count FROM stock_balances WHERE item_id=$1`, [id]),
      this.db.query(`SELECT count(*)::int count FROM stock_transactions WHERE item_id=$1`, [id]),
      this.db.query(`SELECT count(*)::int count FROM production_orders WHERE finished_good_id=$1`, [id]),
      this.db.query(`SELECT count(*)::int count FROM production_order_materials WHERE material_id=$1`, [id]),
      this.db.query(`SELECT count(*)::int count FROM inventory_batches WHERE item_id=$1`, [id]),
    ]);
    return {
      boms: bom.count,
      documents: documents.count,
      balances: balances.count,
      transactions: transactions.count,
      productionOrders: orders.count,
      productionSnapshots: snapshots.count,
      batches: batches.count,
    };
  }

  private async itemTypeRules(id: string) {
    const [[roles], stock] = await Promise.all([
      this.db.query(
        `SELECT
          EXISTS(
            SELECT 1 FROM boms WHERE finished_good_id=$1 AND deleted_at IS NULL
            UNION ALL SELECT 1 FROM production_orders WHERE finished_good_id=$1
          ) "asOutput",
          EXISTS(
            SELECT 1 FROM bom_items bi JOIN boms b ON b.id=bi.bom_id
              WHERE (bi.material_id=$1 OR bi.alternative_material_id=$1) AND b.deleted_at IS NULL
            UNION ALL SELECT 1 FROM production_order_materials WHERE material_id=$1
          ) "asComponent"`,
        [id],
      ),
      this.db.query(
        `SELECT w.id "warehouseId",w.warehouse_code "warehouseCode",w.name "warehouseName",
          w.warehouse_type "warehouseType",sum(sb.on_hand_qty)::text quantity
         FROM stock_balances sb JOIN warehouses w ON w.id=sb.warehouse_id
         WHERE sb.item_id=$1 AND sb.on_hand_qty>0
         GROUP BY w.id ORDER BY w.warehouse_code`,
        [id],
      ),
    ]);
    let allowedTypes = [ItemType.MATERIAL, ItemType.SEMI_FINISHED, ItemType.FINISHED_GOOD];
    const reasons: string[] = [];
    if (roles.asOutput && roles.asComponent) {
      allowedTypes = [ItemType.SEMI_FINISHED];
      reasons.push('该物料同时作为 BOM 产出物料和组成物料，只能设置为半成品');
    } else if (roles.asOutput) {
      allowedTypes = [ItemType.SEMI_FINISHED, ItemType.FINISHED_GOOD];
      reasons.push('该物料作为 BOM 或生产任务的产出物料，只能设置为半成品或成品');
    } else if (roles.asComponent) {
      allowedTypes = [ItemType.MATERIAL, ItemType.SEMI_FINISHED];
      reasons.push('该物料作为 BOM 或生产任务的组成物料，只能设置为原材料或半成品');
    }
    return { allowedTypes, reasons, stock };
  }

  private async validateItemTypeChange(id: string, targetType: ItemType) {
    const rules = await this.itemTypeRules(id);
    if (!rules.allowedTypes.includes(targetType)) {
      throw new BusinessException(
        'ITEM_TYPE_CONFLICT',
        rules.reasons[0] || '该物料的业务引用与目标类型不兼容',
        HttpStatus.CONFLICT,
        { allowedItemTypes: rules.allowedTypes },
      );
    }
    const expectedWarehouseType = targetType === ItemType.FINISHED_GOOD ? 'FG' : 'RAW';
    const conflicts = rules.stock.filter((row: any) => row.warehouseType !== expectedWarehouseType);
    if (conflicts.length) {
      const locations = conflicts.map((row: any) =>
        `${row.warehouseCode} ${row.warehouseName}（${row.quantity}）`).join('、');
      throw new BusinessException(
        'ITEM_TYPE_STOCK_CONFLICT',
        `目标类型应存放在 ${expectedWarehouseType} 类型仓库，但以下仓库仍有库存：${locations}`,
        HttpStatus.CONFLICT,
        { expectedWarehouseType, conflicts },
      );
    }
  }
}
