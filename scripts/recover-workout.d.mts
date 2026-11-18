export function validateRecoveryExport(raw: unknown): { plans: number; sessions: number; people: number; missingPeople: string[] }
export function restoreNewDatabase(data: unknown, factory?: IDBFactory): Promise<{ database: string; plans: number; sessions: number; syncEnabled: false }>
export function startRecoveryServer(data: unknown): Promise<{ url: string; close(): Promise<void> }>
