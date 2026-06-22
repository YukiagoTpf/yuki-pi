import type { Message } from "@earendil-works/pi-ai";

export function processPiEvent(event: unknown, result: unknown): boolean;
export function processPiJsonLine(line: string, result: unknown): boolean;
export function getFinalAssistantText(messages?: Message[]): string;
export function getProcessErrorText(result: unknown): string;
export function getResultSummaryText(result: unknown): string;
