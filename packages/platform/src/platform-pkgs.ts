// The packages the platform provides. Shared by every unit thread and by the deploy's index pass,
// so both resolve them the same way: `instanceof Agent` holds, and every thread shares one storage
// format. Every other package resolves from the deploy's own node_modules.
import { registerHooks } from 'node:module';

/** A deploy must not carry its own copy of these. */
export const PLATFORM_PKGS = new Set(['@mastra/core', 'zod']);

/** 'zod' → 'zod', '@mastra/core/agent' → '@mastra/core'; null for relative, absolute and node: specifiers. */
export function pkgName(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.includes(':')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** From now on, import the platform packages as if from `parentURL`. Call before importing any of them. */
export function resolvePlatformPkgsFrom(parentURL: string) {
  registerHooks({
    resolve: (spec, ctx, next) => (PLATFORM_PKGS.has(pkgName(spec) ?? '') ? next(spec, { ...ctx, parentURL }) : next(spec, ctx)),
  });
}
