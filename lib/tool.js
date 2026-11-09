/**
 * Minimal local replacement for `@deepseek-ai/dsh-tools`'s `defineTool`.
 *
 * A locally installed DSH plugin resolves bare specifiers from the profile's
 * `node_modules`, where `@deepseek-ai/*` host packages are absent (installed
 * plugins ship pre-bundled). To stay self-contained we reproduce the small,
 * observable part of the contract used by this plugin:
 *
 * - `parameters` is a name -> spec map, converted to a JSON Schema object;
 * - `output.schema` is a spec node, converted to a JSON Schema node;
 * - `execute` receives validated arguments;
 * - `presentResult` / `presentationMeta` never see a mismatched argument shape.
 *
 * Only the schema keywords this plugin uses are supported. Unknown keywords are
 * copied through, so extending a spec later stays cheap.
 */

const SPEC_KEYS = new Set(["type", "required", "description", "enum", "items", "properties", "additionalProperties", "default", "minimum", "maximum", "minLength", "maxLength", "title"])

/** Convert one value spec node into a JSON Schema node. */
export function specToJsonSchema(spec) {
  if (spec === undefined || spec === null || typeof spec !== "object") return {}
  const node = {}
  for (const [key, value] of Object.entries(spec)) {
    if (!SPEC_KEYS.has(key)) continue
    if (key === "required" || key === "description" || key === "title") continue
    node[key] = value
  }
  if (spec.description !== undefined) node.description = spec.description
  if (spec.title !== undefined) node.title = spec.title
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.type === "array" && spec.items !== undefined) {
    node.items = specToJsonSchema(spec.items)
  }
  if (spec.type === "object" || spec.properties !== undefined) {
    const properties = {}
    const required = []
    for (const [name, child] of Object.entries(spec.properties ?? {})) {
      properties[name] = specToJsonSchema(child)
      if (child?.required === true) required.push(name)
    }
    if (spec.type === undefined) node.type = "object"
    node.properties = properties
    if (required.length > 0) node.required = required
    if (spec.additionalProperties === undefined) node.additionalProperties = false
  }
  return node
}

/** Convert a parameter name -> spec map into a JSON Schema object node. */
export function parametersToJsonSchema(parameters) {
  return specToJsonSchema({ type: "object", properties: parameters ?? {} })
}

function typeOf(value) {
  if (Array.isArray(value)) return "array"
  if (value === null) return "null"
  return typeof value
}

/** Validate a value against the subset of JSON Schema produced above. */
export function validateValue(schema, value, path = "") {
  const issues = []
  const at = path === "" ? "arguments" : path
  if (schema === undefined || schema === null) return issues
  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => candidate === value)) {
      issues.push(`${at}: expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`)
    }
    return issues
  }
  if (schema.type !== undefined) {
    const actual = typeOf(value)
    const expected = schema.type
    const matches = expected === "integer" ? Number.isInteger(value) : actual === expected
    if (!matches) {
      issues.push(`${at}: expected ${expected}, got ${actual}`)
      return issues
    }
  }
  if (typeof value === "number") {
    if (schema.type !== "integer" && schema.type !== "number") return issues
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${at}: must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${at}: must be <= ${schema.maximum}`)
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      issues.push(...validateValue(schema.items, item, `${path}[${index}]`))
    })
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) issues.push(`${path}.${name}: required`)
    }
    const properties = schema.properties ?? {}
    for (const [name, child] of Object.entries(value)) {
      if (properties[name] !== undefined) {
        issues.push(...validateValue(properties[name], child, `${path}.${name}`.replace(/^\./, "")))
      } else if (schema.additionalProperties === false) {
        issues.push(`${path}.${name}: unknown field`)
      }
    }
  }
  return issues
}

/**
 * Build a tool definition compatible with `ctx.tools.register`.
 *
 * @param {object} options
 * @param {string} options.name model-facing tool name
 * @param {string} options.description model-facing description
 * @param {object} options.parameters name -> spec map
 * @param {{schema: object, render: Function, presentationMeta?: Function}} options.output
 * @param {(args: object, exec: object) => Promise<object>} options.execute
 * @param {Function} [options.presentResult]
 * @param {Function} [options.presentCall]
 */
export function defineTool(options) {
  const parameters = parametersToJsonSchema(options.parameters)
  const outputSchema = specToJsonSchema(options.output.schema)
  const userExecute = options.execute
  const userPresentResult = options.presentResult
  const userPresentCall = options.presentCall
  const userPresentationMeta = options.output.presentationMeta

  if (typeof options.name !== "string" || options.name.length === 0) throw new TypeError("defineTool: name is required")
  if (typeof userExecute !== "function") throw new TypeError(`defineTool(${options.name}): execute is required`)
  if (typeof options.output?.render !== "function") throw new TypeError(`defineTool(${options.name}): output.render is required`)

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const issues = validateValue(parameters, args ?? {})
      if (issues.length > 0) {
        const error = new Error(`${options.name}: ${issues.join("; ")}`)
        error.name = "ToolArgsError"
        error.issues = issues
        throw error
      }
      return userExecute(args, exec)
    },
  }

  if (typeof userPresentationMeta === "function") {
    tool.output.presentationMeta = (args, value) => userPresentationMeta(args, value)
  }
  if (typeof userPresentResult === "function") {
    tool.presentResult = (args, result) => userPresentResult(args, result)
  }
  if (typeof userPresentCall === "function") {
    tool.presentCall = (args) => userPresentCall(args)
  }
  return tool
}
