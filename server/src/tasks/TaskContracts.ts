// <framework:generated sha256=c3c7e1050764103b6a46fafb3b3d22bf8b460278518b3eefbd7c2df99f37a6dd>
import type { Task, TaskListQuery, TaskPage, CreateTaskInput, UpdateTaskInput } from './TaskTypes.js';

export interface TaskRepositoryContract {
  list(query: TaskListQuery): Promise<TaskPage>;
  get(id: string): Promise<Task | null>;
  create(input: CreateTaskInput): Promise<Task>;
  update(id: string, input: UpdateTaskInput): Promise<Task>;
  delete(id: string): Promise<void>;
}
// </framework:generated>
// Add domain-specific internal ports here.
