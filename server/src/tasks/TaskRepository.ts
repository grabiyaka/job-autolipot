// <framework:generated sha256=caeaaa730119e8b94934cabfadbb11b721a2ac05fa595cd08da79ee7b1f855a3>
import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { Task, TaskListQuery, TaskPage, CreateTaskInput, UpdateTaskInput } from './TaskTypes.js';
import type { TaskRepositoryContract } from './TaskContracts.js';

const recordSelection = {
  "id": true,
  "title": true,
  "description": true,
  "completed": true,
  "priority": true,
  "status": true,
  "dueAt": true,
  "tags": true,
  "createdAt": true,
  "updatedAt": true
} satisfies Prisma.TaskSelect;

function recordFromDatabase(record: Prisma.TaskGetPayload<{ select: typeof recordSelection }>): Task {
  return {
    "id": record["id"],
    "title": record["title"],
    "description": record["description"],
    "completed": record["completed"],
    "priority": record["priority"],
    "status": record["status"],
    "dueAt": record["dueAt"] === null ? null : record["dueAt"].toISOString(),
    "tags": record["tags"],
    "createdAt": record["createdAt"].toISOString(),
    "updatedAt": record["updatedAt"].toISOString(),
  };
}

async function databaseOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      if (error.code === 'P2025') throw new ApplicationError('NOT_FOUND', 'Task does not exist.', 404);
      if (error.code === 'P2002') throw new ApplicationError('CONFLICT', 'A unique field is already in use.', 409);
      if (error.code === 'P2003') throw new ApplicationError('RELATION_CONFLICT', 'The operation conflicts with a related record.', 409);
      if (error.code === 'P2000' || error.code === 'P2020' || error.code === 'P2006' || error.code === 'P2007') {
        throw new ApplicationError('INVALID_INPUT', 'A field is outside its database constraints.', 400);
      }
    }
    throw error;
  }
}

export class GeneratedTaskRepository implements TaskRepositoryContract {
  constructor(protected readonly database: Pick<PrismaClient, "task">) {}

  async list(query: TaskListQuery): Promise<TaskPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [records, total] = await databaseOperation(() => Promise.all([
      this.database.task.findMany({ select: recordSelection, orderBy: { "id": 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.database.task.count(),
    ]));
    return { items: records.map(recordFromDatabase), total, page, limit };
  }

  async get(id: string): Promise<Task | null> {
    const record = await databaseOperation(() => this.database.task.findUnique({ where: { "id": id }, select: recordSelection }));
    return record === null ? null : recordFromDatabase(record);
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const data: Prisma.TaskUncheckedCreateInput = {
      "title": input["title"],
      ...(input["description"] !== undefined ? { "description": input["description"] === null ? null : input["description"] } : {}),
      ...(input["completed"] !== undefined ? { "completed": input["completed"] } : {}),
      ...(input["priority"] !== undefined ? { "priority": input["priority"] } : {}),
      ...(input["status"] !== undefined ? { "status": input["status"] } : {}),
      ...(input["dueAt"] !== undefined ? { "dueAt": input["dueAt"] === null ? null : new Date(input["dueAt"]) } : {}),
      ...(input["tags"] !== undefined ? { "tags": input["tags"] } : {}),
    };
    const record = await databaseOperation(() => this.database.task.create({ data, select: recordSelection }));
    return recordFromDatabase(record);
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const data: Prisma.TaskUncheckedUpdateInput = {
      ...(input["title"] !== undefined ? { "title": input["title"] } : {}),
      ...(input["description"] !== undefined ? { "description": input["description"] === null ? null : input["description"] } : {}),
      ...(input["completed"] !== undefined ? { "completed": input["completed"] } : {}),
      ...(input["priority"] !== undefined ? { "priority": input["priority"] } : {}),
      ...(input["status"] !== undefined ? { "status": input["status"] } : {}),
      ...(input["dueAt"] !== undefined ? { "dueAt": input["dueAt"] === null ? null : new Date(input["dueAt"]) } : {}),
      ...(input["tags"] !== undefined ? { "tags": input["tags"] } : {}),
    };
    const record = await databaseOperation(() => this.database.task.update({ where: { "id": id }, data, select: recordSelection }));
    return recordFromDatabase(record);
  }

  async delete(id: string): Promise<void> {
    await databaseOperation(() => this.database.task.delete({ where: { "id": id } }));
  }
}
// </framework:generated>
// Add custom persistence methods here. This section is preserved during generation.
export class TaskRepository extends GeneratedTaskRepository {}
