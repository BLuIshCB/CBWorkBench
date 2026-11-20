export interface SchemaValidationError {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

function getJsonType(val: unknown): string {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function matchesType(val: unknown, expected: string): boolean {
  const actual = getJsonType(val);
  if (expected === 'integer') {
    return typeof val === 'number' && Number.isInteger(val);
  }
  if (expected === 'number') {
    return typeof val === 'number' && Number.isFinite(val);
  }
  return actual === expected;
}

/**
 * Lightweight, dependency-free JSON Schema validator for node output contracts.
 */
export function validateJsonAgainstSchema(
  value: unknown,
  schema: Record<string, any>,
  pointer: string = '$'
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, errors: [{ path: pointer, message: 'Schema 必须是 JSON 对象' }] };
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(value, String(t)))) {
      errors.push({
        path: pointer,
        message: `期望类型 ${allowed.join(' | ')}，实际为 ${getJsonType(value)}`,
      });
      return { valid: false, errors };
    }
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push({ path: pointer, message: `值必须等于常量 ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value));
    if (!ok) {
      errors.push({ path: pointer, message: `值不在允许枚举范围 [${schema.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}] 内` });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path: pointer, message: `字符串长度不能小于 ${schema.minLength}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path: pointer, message: `字符串长度不能大于 ${schema.maxLength}` });
    }
    if (typeof schema.pattern === 'string') {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          errors.push({ path: pointer, message: `字符串不匹配正则 ${schema.pattern}` });
        }
      } catch {
        errors.push({ path: pointer, message: `Schema 包含无效正则表达式: ${schema.pattern}` });
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path: pointer, message: `数值不能小于 ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path: pointer, message: `数值不能大于 ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path: pointer, message: `数组元素数量不能少于 ${schema.minItems}` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path: pointer, message: `数组元素数量不能多于 ${schema.maxItems}` });
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const res = validateJsonAgainstSchema(value[i], schema.items, `${pointer}[${i}]`);
        errors.push(...res.errors);
      }
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in obj) || obj[reqKey] === undefined) {
          errors.push({ path: `${pointer}.${reqKey}`, message: `缺少必需字段 "${reqKey}"` });
        }
      }
    }
    const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
    for (const [k, propSchema] of Object.entries(props)) {
      if (k in obj && obj[k] !== undefined && propSchema && typeof propSchema === 'object') {
        const res = validateJsonAgainstSchema(obj[k], propSchema as Record<string, any>, `${pointer}.${k}`);
        errors.push(...res.errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) {
          errors.push({ path: `${pointer}.${k}`, message: `不允许的额外字段 "${k}"` });
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) {
          const res = validateJsonAgainstSchema(obj[k], schema.additionalProperties, `${pointer}.${k}`);
          errors.push(...res.errors);
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      errors.push(...validateJsonAgainstSchema(value, sub, pointer).errors);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const passed = schema.anyOf.some((sub: any) => validateJsonAgainstSchema(value, sub, pointer).valid);
    if (!passed) {
      errors.push({ path: pointer, message: '不满足 anyOf 中任意子约束' });
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const passCount = schema.oneOf.filter((sub: any) => validateJsonAgainstSchema(value, sub, pointer).valid).length;
    if (passCount !== 1) {
      errors.push({ path: pointer, message: `必须恰好满足 oneOf 中的 1 个约束（实际满足 ${passCount} 个）` });
    }
  }

  return { valid: errors.length === 0, errors };
}
