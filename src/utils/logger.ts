import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/constants.ts';

export class Logger {
  private logFile: string;
  private context: string;

  constructor(context: string = 'Workbench') {
    this.context = context;
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.logFile = path.join(DATA_DIR, 'workbench.log');
  }

  private write(level: string, message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    let formatted = `[${timestamp}] [${level}] [${this.context}] ${message}`;
    if (data !== undefined) {
      if (data instanceof Error) {
        formatted += `\n${data.stack || data.message}`;
      } else if (typeof data === 'object') {
        formatted += ` ${JSON.stringify(data)}`;
      } else {
        formatted += ` ${String(data)}`;
      }
    }

    if (process.env.MCP_MODE === 'true' || process.env.IS_MCP === 'true') {
      console.error(formatted);
    } else if (level === 'ERROR') {
      console.error(formatted);
    } else if (level === 'WARN') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    try {
      fs.appendFileSync(this.logFile, formatted + '\n', 'utf8');
    } catch {
      // Ignore file write failure
    }
  }

  info(message: string, data?: unknown): void {
    this.write('INFO', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write('WARN', message, data);
  }

  error(message: string, data?: unknown): void {
    this.write('ERROR', message, data);
  }

  debug(message: string, data?: unknown): void {
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      this.write('DEBUG', message, data);
    }
  }
}

export const logger = new Logger('App');
