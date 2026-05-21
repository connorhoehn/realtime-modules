/**
 * FeatureManifest — every realtime feature (chat, presence, document-sharing,
 * …) ships a manifest declaring the env vars it needs, the WS channels it
 * touches, its event-catalog declaration export, and any optional install
 * hooks for backend route mounting / suggested frontend imports.
 *
 * Consumers (gateway, edge-gateway, realtime-fanout, apps) read these
 * manifests to wire up a feature without coupling to its internals.
 */
export interface FeatureManifest {
  /** Stable feature identifier, e.g. 'chat', 'presence', 'document-sharing'. */
  name: string;

  /** Semver of the feature itself (independent of the package version). */
  version: string;

  /** Env vars the feature reads. Used for validation + docs generation. */
  envVars?: Record<
    string,
    {
      required?: boolean;
      default?: string;
      description: string;
    }
  >;

  /** WS channel patterns the feature subscribes to or publishes on. */
  channels?: string[];

  /** Module path to an EventDeclaration[] export (event-catalog format). */
  declarations?: string;

  /** Other feature names this one requires to be installed first. */
  dependencies?: string[];

  /** Optional install hooks the host application can call. */
  install?: {
    /** Module path to a backend route-mounter (e.g. (app) => void). */
    backendRoutes?: string;
    /** Suggested frontend import path for UI components. */
    frontendImport?: string;
  };
}
