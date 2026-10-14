export function auditBuildDirectories(distRoot: string, nativeRoot: string): Promise<void>;
export function auditPackageInputs(): Promise<void>;
export function auditPackagedApp(appOutDir: string): Promise<void>;
export const EXPECTED_NATIVE_FILES: string[];
export function auditMoonshineModel(root: string): Promise<void>;
