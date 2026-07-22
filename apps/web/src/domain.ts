export const statusText:Record<string,string>={ACTIVE:'启用',INACTIVE:'停用',DRAFT:'草稿',POSTED:'已过账',VOIDED:'已冲销',RELEASED:'已发布',IN_PROGRESS:'生产中',COMPLETED:'已完成',CANCELLED:'已取消',MATERIAL_INBOUND:'原材料入库',FINISHED_INBOUND:'成品入库',FINISHED_OUTBOUND:'成品出库',PRODUCTION_ISSUE:'生产领料',PRODUCTION_RETURN:'生产退料',PRODUCTION_COMPLETION:'完工入库',REVERSAL:'冲销'};
export const canAccessRole=(allowed:string[],role:string)=>allowed.includes(role);
export const formatQuantity=(value:unknown)=>Number(value||0).toFixed(4).replace(/\.?(0+)$/,'');
