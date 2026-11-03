// <framework:generated sha256=13994bc2f941f57bac2ae653d72d890a55bd255afa5e1ca11463d8b27edbcb82>
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type {} from '@fastify/swagger';
import type { TaskApi, TaskOperation, CreateTaskInput, UpdateTaskInput } from './TaskTypes.js';
import { TaskController } from './TaskController.js';
import { errors } from '../../framework/http/error-schema.js';

const recordSchema = {
  "$id": "crud.tasks.Task",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "title",
    "description",
    "completed",
    "priority",
    "status",
    "dueAt",
    "tags",
    "createdAt",
    "updatedAt"
  ],
  "properties": {
    "id": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "description": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "completed": {
      "type": "boolean"
    },
    "priority": {
      "type": "integer",
      "minimum": -2147483648,
      "maximum": 2147483647
    },
    "status": {
      "type": "string",
      "enum": [
        "OPEN",
        "IN_PROGRESS",
        "DONE"
      ]
    },
    "dueAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time"
        },
        {
          "type": "null"
        }
      ]
    },
    "tags": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "createdAt": {
      "type": "string",
      "format": "date-time"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time"
    }
  }
} as const;

const createSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "title"
  ],
  "properties": {
    "title": {
      "type": "string"
    },
    "description": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "completed": {
      "type": "boolean"
    },
    "priority": {
      "type": "integer",
      "minimum": -2147483648,
      "maximum": 2147483647
    },
    "status": {
      "type": "string",
      "enum": [
        "OPEN",
        "IN_PROGRESS",
        "DONE"
      ]
    },
    "dueAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$"
        },
        {
          "type": "null"
        }
      ]
    },
    "tags": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
} as const;

const updateSchema = {
  "type": "object",
  "additionalProperties": false,
  "minProperties": 1,
  "required": [],
  "properties": {
    "title": {
      "type": "string"
    },
    "description": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "completed": {
      "type": "boolean"
    },
    "priority": {
      "type": "integer",
      "minimum": -2147483648,
      "maximum": 2147483647
    },
    "status": {
      "type": "string",
      "enum": [
        "OPEN",
        "IN_PROGRESS",
        "DONE"
      ]
    },
    "dueAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$"
        },
        {
          "type": "null"
        }
      ]
    },
    "tags": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
} as const;

const identifierSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id"
  ],
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    }
  }
} as const;

export type TaskRouteAccess = Readonly<Partial<Record<TaskOperation, preHandlerHookHandler | preHandlerHookHandler[]>>>;

export function registerTaskCrudRoutes<Context>(
  server: FastifyInstance,
  api: TaskApi<Context>,
  context: (request: FastifyRequest) => Context | Promise<Context>,
  access: TaskRouteAccess = {},
): void {
  server.addSchema(recordSchema);
  const controller = new TaskController(api, context);

  server.get<{ Querystring: { page?: string; limit?: string } }>("/api/tasks", {
    ...(access.list ? { preHandler: access.list } : {}),
    schema: {
      tags: ["Task"], summary: "List tasks",
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 }, limit: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 3 } },
      },
      response: { 200: {
        type: 'object', additionalProperties: false, required: ['items', 'total', 'page', 'limit'],
        properties: { items: { type: 'array', items: { $ref: "crud.tasks.Task#" } }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } },
      }, ...errors },
    },
    handler: controller.list,
  });

  server.get<{ Params: { id: string } }>("/api/tasks/:id", {
    ...(access.get ? { preHandler: access.get } : {}),
    schema: { tags: ["Task"], summary: "Get Task", params: identifierSchema, response: { 200: { $ref: "crud.tasks.Task#" }, ...errors } },
    handler: controller.get,
  });

  server.post<{ Body: CreateTaskInput }>("/api/tasks", {
    ...(access.create ? { preHandler: access.create } : {}),
    schema: { tags: ["Task"], summary: "Create Task", body: createSchema, response: { 201: { $ref: "crud.tasks.Task#" }, ...errors } },
    handler: controller.create,
  });

  server.patch<{ Params: { id: string }; Body: UpdateTaskInput }>("/api/tasks/:id", {
    ...(access.update ? { preHandler: access.update } : {}),
    schema: { tags: ["Task"], summary: "Update Task", params: identifierSchema, body: updateSchema, response: { 200: { $ref: "crud.tasks.Task#" }, ...errors } },
    handler: controller.update,
  });

  server.delete<{ Params: { id: string } }>("/api/tasks/:id", {
    ...(access.delete ? { preHandler: access.delete } : {}),
    schema: { tags: ["Task"], summary: "Delete Task", params: identifierSchema, response: { 204: { type: 'null' }, ...errors } },
    handler: controller.delete,
  });
}
// </framework:generated>
// Register custom routes here. This section is preserved during generation.
import { adminAccess } from '../../middlewares/adminAccess.js';
import { generalAccess } from '../../middlewares/generalAccess.js';
import { guestAccess } from '../../middlewares/guestAccess.js';

export function registerTaskRoutes<Context>(
  server: FastifyInstance,
  api: TaskApi<Context>,
  context: (request: FastifyRequest) => Context | Promise<Context>,
): void {
  registerTaskCrudRoutes(server, api, context, {
    list: guestAccess,
    get: guestAccess,
    create: generalAccess,
    update: generalAccess,
    delete: adminAccess,
  });
}
