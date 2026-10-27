export declare const CONTRACT_READ_ROLES: readonly string[];
export declare const CONTRACT_READ_ALL_ROLES: readonly string[];

export declare function canReadContracts(role: unknown): boolean;
export declare function contractsScopedToOwner(role: unknown): boolean;
