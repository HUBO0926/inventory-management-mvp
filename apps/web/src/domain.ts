export const statusText:Record<string,string>={ACTIVE:'启用',INACTIVE:'停用',DRAFT:'草稿',SUBMITTED:'待审核',APPROVED:'已审核',REJECTED:'已驳回',POSTED:'已过账',VOIDED:'已冲销',RELEASED:'已发布',AWAITING_ISSUE:'待领料',IN_PROGRESS:'生产中',AWAITING_COMPLETION:'待完工',COMPLETED:'已完成',CLOSED:'已关闭',CANCELLED:'已取消',MATERIAL_INBOUND:'原材料入库',FINISHED_INBOUND:'成品入库',FINISHED_OUTBOUND:'成品出库',INVENTORY_ADJUSTMENT:'库存调整',STOCK_MOVE:'移库',STOCK_CHECK:'盘点',PRODUCTION_ISSUE:'生产领料',PRODUCTION_RETURN:'生产退料',PRODUCTION_COMPLETION:'完工入库',REVERSAL:'冲销'};
statusText.DEFECTIVE_RETURN='不良原料退货';
statusText.DEFECTIVE_REPAIR_RESTOCK='不良原料维修入库';
statusText.DEFECTIVE_PRODUCTION_RETURN='不良成品退生产';
export const canAccessRole=(allowed:string[],role:string)=>allowed.includes(role);
export const formatQuantity=(value:unknown)=>Math.round(Number(value||0)).toLocaleString('zh-CN',{maximumFractionDigits:0});
export const formatBeijingTime=(value:unknown)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(String(value))).replaceAll('/','-'):'—';
