export interface InheritedCliArgs {
  extensionArgs: string[];
  alwaysProxy: string[];
  fallbackModel?: string;
  fallbackThinking?: string;
  fallbackTools?: string;
  fallbackNoTools: boolean;
  sessionDir?: string;
}

export function parseInheritedCliArgs(argv: string[]): InheritedCliArgs;
