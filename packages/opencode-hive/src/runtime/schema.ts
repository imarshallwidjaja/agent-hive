import { z } from 'zod';

/**
 * Operation argument and recovery-contract schemas are plain Zod 4.1.8 (`zod` is pinned exactly). This module
 * imports no host SDK: the v1 registrar passes `operation.args` to its own tool factory, and the SDK builds
 * that factory on the same `zod` package, so the schemas validate identically under either host.
 */
export { z };

/** The raw argument shape an operation declares. */
export type ArgShape = z.ZodRawShape;

/** The parsed input an operation receives for its declared argument shape. */
export type ArgInput<Shape extends ArgShape> = z.infer<z.ZodObject<Shape>>;
