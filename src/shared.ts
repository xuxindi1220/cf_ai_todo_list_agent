// Approval string to be shared across frontend and backend
export const APPROVAL = {
  YES: "Yes, confirmed.",
  NO: "No, denied."
} as const;

// Minimal Todo type used by the frontend UI for the todo table
export type Todo = {
  id: string;
  title: string;
  due?: string; // ISO date or plain date string
  priority?: "low" | "medium" | "high";
  estimatedMinutes?: number;
  done?: boolean;
  createdAt?: string;
};

// Simple id generator for demo purposes
export function generateId(prefix = "t") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
