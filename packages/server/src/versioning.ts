/**
 * Lightweight semver utilities for API versioning.
 * No external dependencies.
 */

// ============================================
// Types
// ============================================

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Original string (e.g., "2.1.0") */
  raw: string;
}

export interface VersioningConfig {
  /** What to do when no X-API-Version header is sent.
   * - "latest": resolve to the highest registered version (default)
   * - "unversioned": prefer unversioned route if available, else latest
   * - "error": return 400 if no version header
   */
  defaultBehavior?: "latest" | "unversioned" | "error";
  /** Echo the resolved version in the response header (default: true) */
  echoVersion?: boolean;
  /** Custom header name (default: "X-API-Version") */
  headerName?: string;
}

export interface DeprecationInfo {
  /** ISO date when this version will be removed */
  sunsetDate?: string;
  /** Human-readable deprecation message */
  message?: string;
  /** Suggested successor version (e.g., "2.0.0") */
  successor?: string;
}

export interface RouterOptions {
  /** Semver version for this router (e.g., "1.0.0", "2.1.0") */
  version?: string;
  /** Mark this router version as deprecated */
  deprecated?: DeprecationInfo;
}

// ============================================
// Parsing
// ============================================

/**
 * Parse a semver string into a SemVer object.
 * Accepts "2.1.0", "v2.1.0", "2.1", "2".
 */
export function parseSemVer(version: string): SemVer | null {
  if (!version) return null;

  // Strip leading "v" or "V"
  const cleaned = version.trim().replace(/^[vV]/, "");

  const parts = cleaned.split(".");
  if (parts.length === 0 || parts.length > 3) return null;

  const major = parseInt(parts[0]!, 10);
  if (isNaN(major) || major < 0) return null;

  const minor = parts.length >= 2 ? parseInt(parts[1]!, 10) : 0;
  if (isNaN(minor) || minor < 0) return null;

  const patch = parts.length >= 3 ? parseInt(parts[2]!, 10) : 0;
  if (isNaN(patch) || patch < 0) return null;

  return { major, minor, patch, raw: `${major}.${minor}.${patch}` };
}

// ============================================
// Comparison
// ============================================

/**
 * Compare two SemVer objects.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

// ============================================
// Matching
// ============================================

/**
 * Check if a registered version satisfies a requested version string.
 *
 * Supported request formats:
 * - "2"       → matches any 2.x.x (major only)
 * - "2.1"     → matches any 2.1.x (major.minor)
 * - "2.1.0"   → exact match
 * - "2.x"     → matches any 2.x.x (wildcard minor)
 * - "2.1.x"   → matches any 2.1.x (wildcard patch)
 * - "2.x.x"   → matches any 2.x.x (wildcard minor+patch)
 */
export function satisfies(registered: SemVer, requested: string): boolean {
  if (!requested) return false;

  const cleaned = requested.trim().replace(/^[vV]/, "");
  const parts = cleaned.split(".");

  // Parse major
  const majorStr = parts[0];
  if (!majorStr || majorStr === "x" || majorStr === "*") return true; // match all
  const major = parseInt(majorStr, 10);
  if (isNaN(major)) return false;
  if (registered.major !== major) return false;

  // Major only (e.g., "2") or wildcard minor (e.g., "2.x", "2.*")
  if (parts.length === 1) return true;
  const minorStr = parts[1];
  if (!minorStr || minorStr === "x" || minorStr === "*") return true;
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return false;
  if (registered.minor !== minor) return false;

  // Major.minor only (e.g., "2.1") or wildcard patch (e.g., "2.1.x")
  if (parts.length === 2) return true;
  const patchStr = parts[2];
  if (!patchStr || patchStr === "x" || patchStr === "*") return true;
  const patch = parseInt(patchStr, 10);
  if (isNaN(patch)) return false;
  return registered.patch === patch;
}

/**
 * Resolve the best matching version from a sorted list.
 * Returns the highest version that satisfies the requested string.
 * Versions should be sorted highest-first for efficiency.
 */
export function resolveVersion(
  versions: SemVer[],
  requested: string
): SemVer | null {
  // Sort highest-first (in case caller didn't)
  const sorted = [...versions].sort((a, b) => compareSemVer(b, a));

  for (const ver of sorted) {
    if (satisfies(ver, requested)) {
      return ver;
    }
  }

  return null;
}
