/** Minimal checker for the JSON Schema subset the design schemas use. */
export function schemaErrors(schema: any, value: any, path = "$"): string[] {
  if (schema.anyOf)
    return schema.anyOf.some((s: any) => !schemaErrors(s, value, path).length)
      ? []
      : [`${path} matches no alternative`];
  if ("const" in schema)
    return value === schema.const ? [] : [`${path} must equal ${schema.const}`];
  if (schema.enum)
    return schema.enum.includes(value) ? [] : [`${path} not in enum`];
  const type = Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : Number.isInteger(value)
        ? "integer"
        : typeof value;
  if (
    schema.type &&
    schema.type !== type &&
    !(schema.type === "number" && type === "integer")
  )
    return [`${path} should be ${schema.type}, got ${type}`];
  const errors: string[] = [];
  if (type === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path} too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path} too long`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      errors.push(`${path} does not match ${schema.pattern}`);
  }
  if (type === "number" || type === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path} above ${schema.maximum}`);
  }
  if (type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path} has too many items`);
    if (schema.items)
      value.forEach((v: any, i: number) =>
        errors.push(...schemaErrors(schema.items, v, `${path}[${i}]`)),
      );
  }
  if (type === "object" && schema.properties) {
    for (const key of schema.required ?? [])
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      if (key in schema.properties)
        errors.push(
          ...schemaErrors(schema.properties[key], v, `${path}.${key}`),
        );
      else if (schema.additionalProperties === false)
        errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}
