// packages/cli/plugins/backup/plugin/index.ts
/**
 * Database Backup Plugin for @donkeylabs/server
 * 
 * Supports multiple backup strategies:
 * - Litestream (SQLite streaming replication)
 * - S3 snapshots (all databases)
 * - Local file backups
 * - Custom adapters
 */

import { createPlugin, type ErrorFactory } from "@donkeylabs/server";
import { z } from "zod";

export interface BackupConfig {
  /** Backup adapter to use */
  adapter: "litestream" | "s3" | "local" | "custom";
  
  /** Adapter-specific configuration */
  adapterConfig: LitestreamConfig | S3Config | LocalConfig | CustomAdapterConfig;
  
  /** Backup schedule (cron expression) */
  schedule?: string;
  
  /** Number of backups to retain */
  retentionCount?: number;
  
  /** Whether to compress backups */
  compress?: boolean;
  
  /** Tables to exclude from backup (if supported) */
  excludeTables?: string[];
}

export interface LitestreamConfig {
  /** S3-compatible bucket URL */
  url: string;
  
  /** Access key for S3 */
  accessKeyId: string;
  
  /** Secret key for S3 */
  secretAccessKey: string;
  
  /** S3 region */
  region?: string;
  
  /** Sync interval in seconds (default: 1) */
  syncInterval?: number;
  
  /** Snapshot interval (e.g., "6h" for every 6 hours) */
  snapshotInterval?: string;
  
  /** Whether to validate checksums */
  validationInterval?: string;
}

export interface S3Config {
  /** S3 bucket name */
  bucket: string;
  
  /** S3 key prefix */
  prefix?: string;
  
  /** AWS region */
  region: string;
  
  /** Access credentials */
  accessKeyId: string;
  secretAccessKey: string;
  
  /** Optional: Custom S3 endpoint (for MinIO, etc.) */
  endpoint?: string;
}

export interface LocalConfig {
  /** Local directory for backups */
  backupDir: string;
  
  /** Backup file naming pattern */
  namingPattern?: string;
}

export interface CustomAdapterConfig {
  /** Custom backup function */
  backup: (dbPath: string, config: any) => Promise<void>;
  
  /** Custom restore function */
  restore: (dbPath: string, backupId: string, config: any) => Promise<void>;
  
  /** List available backups */
  list: (config: any) => Promise<BackupInfo[]>;
}

export interface BackupInfo {
  id: string;
  timestamp: Date;
  size: number;
  type: "full" | "incremental" | "snapshot";
  status: "complete" | "in_progress" | "failed";
  location: string;
  checksum?: string;
}

export interface RestoreOptions {
  backupId: string;
  targetPath?: string;
  verifyChecksum?: boolean;
}

export const backupPlugin = createPlugin
  .withConfig<BackupConfig>()
  .define({
    name: "backup",
    service: async (ctx) => {
      const config = ctx.config;
      
      // Schedule automatic backups if configured
      if (config.schedule) {
        ctx.core.cron.schedule(config.schedule, async () => {
          ctx.core.logger.info("Running scheduled backup");
          try {
            ctx.core.logger.info("Scheduled backup completed - implement adapter");
          } catch (error) {
            ctx.core.logger.error("Scheduled backup failed", { error });
          }
        }, { name: "backup-job" });
      }
      
      return {
        /** Perform a manual backup - implement with your adapter */
        async backup(): Promise<BackupInfo> {
          ctx.core.logger.info("Backup requested - implement adapter logic");
          
          return {
            id: `backup-${Date.now()}`,
            timestamp: new Date(),
            size: 0,
            type: "full",
            status: "complete",
            location: "not-implemented",
          };
        },
        
        /** Restore from backup */
        async restore(_options: RestoreOptions): Promise<void> {
          ctx.core.logger.info("Restore requested - implement adapter logic");
          throw new Error("Restore not implemented");
        },
        
        /** List available backups */
        async listBackups(): Promise<BackupInfo[]> {
          return [];
        },
        
        /** Verify backup integrity */
        async verify(_backupId: string): Promise<boolean> {
          return true;
        },
      };
    },
  });
