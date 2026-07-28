import { AuthUser } from './constants';

/** 从 AuthUser 提取操作人快照字段，用于 INSERT/UPDATE */
export function snapshotUser(user: AuthUser | null | undefined) {
  if (!user) {
    return {
      userId: null,
      username: null,
      name: null,
      department: null,
    };
  }
  return {
    userId: user.id,
    username: user.username,
    name: user.employeeName || user.name || user.username,
    department: user.department || null,
  };
}

/** 生成一组用于 INSERT 的 SQL 快照列和值占位符，从 $idx 开始计数 */
export function snapshotSqlColumns(prefix: string): string {
  return `"${prefix}_user_id","${prefix}_username","${prefix}_name","${prefix}_department"`;
}

/** 从 snapshot 中提取 SQL 参数值数组 */
export function snapshotSqlValues(snap: ReturnType<typeof snapshotUser>): any[] {
  return [snap.userId, snap.username, snap.name, snap.department];
}
