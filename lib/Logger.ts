'use strict';

export default class Logger {
  public static DEBUG = false;

  public static app(...args: any[]): void {
    Logger.debugWithPrefix('App', ...args);
  }

  public static driver(...args: any[]): void {
    Logger.debugWithPrefix('Driver', ...args);
  }

  public static device(...args: any[]): void {
    Logger.debugWithPrefix('Device', ...args);
  }

  public static api(title: string, obj: unknown): void {
    if (!Logger.DEBUG) {
      return;
    }

    console.log('');
    console.log('====================================================');
    console.log(`[API] ${title}`);
    console.log('====================================================');
    console.log(JSON.stringify(obj, null, 2));
    console.log('====================================================');
    console.log('');
  }

  public static object(title: string, obj: unknown): void {
    if (!Logger.DEBUG) {
      return;
    }

    console.log('');
    console.log(`========== ${title} ==========`);
    console.log(JSON.stringify(obj, null, 2));
    console.log('===================================');
    console.log('');
  }

  public static warn(...args: any[]): void {
    console.warn('[WARN]', ...args);
  }

  public static error(...args: any[]): void {
    console.error('[ERROR]', ...args);
  }

  private static debugWithPrefix(prefix: string, ...args: any[]): void {
    if (!Logger.DEBUG) {
      return;
    }

    console.log(`[${prefix}]`, ...args);
  }
}