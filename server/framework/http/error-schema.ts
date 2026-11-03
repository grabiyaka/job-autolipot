const text = { type: 'string' } as const;

export const errorSchema = {
  type: 'object', required: ['error'], properties: {
    error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: text, message: text, requestId: text } },
  },
} as const;

export const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 500: errorSchema };
