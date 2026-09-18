import { Injectable } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { BusinessException } from '../common/business.exception';
import { ApprovalHistoryService } from '../audit/approval-history.service';

@Injectable()
export class ApprovalWorkflowService {
  constructor(private readonly history: ApprovalHistoryService) {}

  async submit(qr: QueryRunner, documentId: string, applicantId: string, previousStatus = 'DRAFT') {
    const [applicant] = await qr.query(`SELECT u.name,u.manager_user_id,m.name manager_name,m.status manager_status,m.can_approve AS manager_can_approve,m.position_type manager_position FROM users u LEFT JOIN users m ON m.id=u.manager_user_id WHERE u.id=$1`, [applicantId]);
    if (!applicant?.manager_user_id || applicant.manager_status !== 'ACTIVE' || !applicant.manager_can_approve || !['MANAGER','SYSTEM_ADMIN'].includes(applicant.manager_position)) throw new BusinessException('APPROVAL_MANAGER_MISSING', '当前账号尚未配置有效的上级审批人员，请联系系统管理员完成配置');
    const [instance] = await qr.query(`INSERT INTO approval_instance(document_id,business_type,business_id,applicant_user_id,applicant_name,status) VALUES($1,(SELECT document_type FROM stock_documents WHERE id=$1),$1,$2,$3,'PENDING') ON CONFLICT(document_id) DO UPDATE SET applicant_user_id=EXCLUDED.applicant_user_id,applicant_name=EXCLUDED.applicant_name,status='PENDING',completed_at=NULL RETURNING id`, [documentId, applicantId, applicant.name]);
    await qr.query(`UPDATE approval_task SET status='REVOKED',approved_at=now() WHERE approval_instance_id=$1 AND status='PENDING'`, [instance.id]);
    await qr.query(`INSERT INTO approval_task(approval_instance_id,approver_user_id,approver_name,status) VALUES($1,$2,$3,'PENDING') ON CONFLICT(approval_instance_id,approver_user_id) DO UPDATE SET status='PENDING',approval_opinion=NULL,approved_at=NULL`, [instance.id, applicant.manager_user_id, applicant.manager_name]);
    const [doc] = await qr.query(`SELECT document_no,document_type FROM stock_documents WHERE id=$1`, [documentId]);
    await qr.query(`INSERT INTO notification(receiver_user_id,type,title,content,business_type,business_id) VALUES($1,'APPROVAL_SUBMITTED','新的审批待办',$2,$3,$4)`, [applicant.manager_user_id, `单据 ${doc.document_no} 已提交，请及时审批。`, doc.document_type, documentId]);
    await this.history.record(qr, documentId, 'SUBMITTED', previousStatus, 'SUBMITTED', applicantId);
  }

  async closePending(qr: QueryRunner, documentId: string, action: 'REVOKED'|'RETURNED', reason?: string) {
    const [instance] = await qr.query(`SELECT a.id,d.document_no,d.document_type FROM approval_instance a JOIN stock_documents d ON d.id=a.document_id WHERE a.document_id=$1 FOR UPDATE`, [documentId]);
    if (!instance) return;
    const changed = await qr.query(`UPDATE approval_task SET status=$1,approval_opinion=$2,approved_at=now() WHERE approval_instance_id=$3 AND status='PENDING' RETURNING approver_user_id AS "approverUserId"`, [action, reason || null, instance.id]);
    const tasks = Array.isArray(changed?.[0]) ? changed[0] : changed;
    await qr.query(`UPDATE approval_instance SET status=$1,completed_at=now() WHERE id=$2`, [action, instance.id]);
    for (const task of tasks) await qr.query(`INSERT INTO notification(receiver_user_id,type,title,content,business_type,business_id) VALUES($1,$2,$3,$4,$5,$6)`, [task.approverUserId, action === 'REVOKED' ? 'APPROVAL_REVOKED' : 'APPROVAL_RETURNED', action === 'REVOKED' ? '审批已撤回' : '审批已退回', `单据 ${instance.document_no} 的审批状态已更新。`, instance.document_type, documentId]);
  }
}
