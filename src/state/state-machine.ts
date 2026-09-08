export type ExecutionState =
  | "WATCHING"
  | "LIQUIDITY_FOUND"
  | "QUOTE_READY"
  | "TRANSACTION_READY"
  | "AUTHORIZED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED";

const VALID_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  WATCHING: ["LIQUIDITY_FOUND", "FAILED"],
  LIQUIDITY_FOUND: ["QUOTE_READY", "FAILED", "WATCHING"],
  QUOTE_READY: ["TRANSACTION_READY", "FAILED", "WATCHING"],
  TRANSACTION_READY: ["AUTHORIZED", "FAILED", "WATCHING"],
  AUTHORIZED: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["CONFIRMED", "FAILED"],
  CONFIRMED: [],
  FAILED: ["WATCHING"],
};

export function isValidTransition(from: ExecutionState, to: ExecutionState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidStateTransitionError extends Error {
  constructor(from: ExecutionState, to: ExecutionState) {
    super(`Invalid state transition: ${from} -> ${to}`);
  }
}
