export enum Role {
  ADMIN = 'ADMIN',
  WAREHOUSE = 'WAREHOUSE',
  PRODUCTION = 'PRODUCTION',
}

export enum ItemType {
  MATERIAL = 'MATERIAL',
  FINISHED_GOOD = 'FINISHED_GOOD',
}

export enum EntityStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export enum DocumentStatus {
  DRAFT = 'DRAFT',
  POSTED = 'POSTED',
  VOIDED = 'VOIDED',
}

export enum DocumentType {
  MATERIAL_INBOUND = 'MATERIAL_INBOUND',
  FINISHED_INBOUND = 'FINISHED_INBOUND',
  PRODUCTION_ISSUE = 'PRODUCTION_ISSUE',
  PRODUCTION_RETURN = 'PRODUCTION_RETURN',
  PRODUCTION_COMPLETION = 'PRODUCTION_COMPLETION',
  FINISHED_OUTBOUND = 'FINISHED_OUTBOUND',
  REVERSAL = 'REVERSAL',
}

export enum Direction {
  IN = 'IN',
  OUT = 'OUT',
}

export enum ProductionStatus {
  DRAFT = 'DRAFT',
  RELEASED = 'RELEASED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: Role;
}
