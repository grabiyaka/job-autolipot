// <framework:generated sha256=d9266ca2ef60c4e92708a17127cb06536918655752e2c24b8dbd3dcfab7788e1>
export type Task = Readonly<{
  "id": string;
  "title": string;
  "description": string | null;
  "completed": boolean;
  "priority": number;
  "status": "OPEN" | "IN_PROGRESS" | "DONE";
  "dueAt": string | null;
  "tags": Array<string>;
  "createdAt": string;
  "updatedAt": string;
}>;

export type CreateTaskInput = Readonly<{
  "title": string;
  "description"?: string | null;
  "completed"?: boolean;
  "priority"?: number;
  "status"?: "OPEN" | "IN_PROGRESS" | "DONE";
  "dueAt"?: string | null;
  "tags"?: Array<string>;
}>;
export type UpdateTaskInput = Readonly<{
  "title"?: string;
  "description"?: string | null;
  "completed"?: boolean;
  "priority"?: number;
  "status"?: "OPEN" | "IN_PROGRESS" | "DONE";
  "dueAt"?: string | null;
  "tags"?: Array<string>;
}>;
export type TaskListQuery = Readonly<{ page?: number; limit?: number }>;
export type TaskPage = Readonly<{ items: Task[]; total: number; page: number; limit: number }>;
export type TaskOperation = "list" | "get" | "create" | "update" | "delete";
export type TaskAuthorization<Context> = (operation: TaskOperation, context: Context) => void | Promise<void>;

export interface TaskCrudApi<Context> {
  list(query: TaskListQuery, context: Context): Promise<TaskPage>;
  get(id: string, context: Context): Promise<Task>;
  create(input: CreateTaskInput, context: Context): Promise<Task>;
  update(id: string, input: UpdateTaskInput, context: Context): Promise<Task>;
  delete(id: string, context: Context): Promise<void>;
}
// </framework:generated>
// Add custom public contracts here. This section is preserved during generation.
export interface TaskApi<Context> extends TaskCrudApi<Context> {}
