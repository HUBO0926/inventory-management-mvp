import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DataSource) {}
  async list(userId: string, q: any) {
    const limit = Math.min(Number(q.pageSize || 30), 100);
    return this.db.query(`SELECT id,type,title,content,business_type "businessType",business_id "businessId",is_read "isRead",created_at "createdAt",read_at "readAt"
      FROM notification WHERE receiver_user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
  }
  async unreadCount(userId: string) { const [row] = await this.db.query(`SELECT count(*)::int count FROM notification WHERE receiver_user_id=$1 AND is_read=false`, [userId]); return { count: Number(row?.count || 0) }; }
  async read(id: string, userId: string) { await this.db.query(`UPDATE notification SET is_read=true,read_at=COALESCE(read_at,now()) WHERE id=$1 AND receiver_user_id=$2`, [id,userId]); return { ok: true }; }
  async readAll(userId: string) { await this.db.query(`UPDATE notification SET is_read=true,read_at=COALESCE(read_at,now()) WHERE receiver_user_id=$1 AND is_read=false`, [userId]); return { ok: true }; }
}
