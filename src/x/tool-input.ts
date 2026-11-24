import { Type } from "typebox";

export const reference = (description: string) =>
  Type.String({ description, minLength: 1, maxLength: 2048 });
export const cursor = Type.Optional(
  Type.Union([Type.String({ maxLength: 16000 }), Type.Null()], {
    description:
      "Omit, null or an empty/whitespace-only string for the first page. Otherwise pass next_cursor from the same operation, query and provider exactly; never invent sentinels such as -1, / or .remove.",
  })
);

export class XToolError extends Error {
  readonly data;

  constructor(recovery: {
    code: string;
    field: string;
    message: string;
    suggestedAction: string;
    next_call: { tool: string; arguments: object };
  }) {
    super(recovery.message);
    this.name = "XToolError";
    const { code, field, message, suggestedAction, next_call } = recovery;
    this.data = {
      outcome: "error",
      code,
      field,
      message,
      retryable: false,
      suggestedAction,
      next_call,
    };
  }
}
