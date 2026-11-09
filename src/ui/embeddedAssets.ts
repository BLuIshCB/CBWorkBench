export interface EmbeddedAsset {
  content: string;
  contentType: string;
}

/**
 * Embedded UI assets dictionary.
 * Fallback when static files are bundled inside standalone executables.
 */
export const EMBEDDED_ASSETS: Record<string, EmbeddedAsset> = {};
