import { bad } from "./errors.js";

type Schema = { properties?: Record<string, unknown>; required?: string[] };

const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

export class Args {
  private constructor(readonly raw: Record<string, unknown>) {}

  static parse(schema: Schema, value: unknown): Args {
    let m: Record<string, unknown>;
    if (value === undefined || value === null) m = {};
    else if (typeof value === "object" && !Array.isArray(value)) m = value as Record<string, unknown>;
    else throw bad("arguments must be an object");
    const props = Object.keys(schema.properties ?? {}).sort();
    const unknown = Object.keys(m).find((k) => !props.includes(k));
    if (unknown !== undefined) {
      throw bad(`unknown argument \`${unknown}\`; this tool takes ${props.join(", ")}`);
    }
    for (const r of schema.required ?? []) {
      if (m[r] === undefined || m[r] === null) throw bad(`\`${r}\` is required`);
    }
    return new Args(m);
  }

  str(k: string): string | undefined {
    const v = this.raw[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw bad(`\`${k}\` must be a string`);
    const t = v.trim();
    return t ? t : undefined;
  }

  reqStr(k: string): string {
    const v = this.str(k);
    if (v === undefined) throw bad(`\`${k}\` is required`);
    return v;
  }

  rawStr(k: string): string | undefined {
    const v = this.raw[k];
    return typeof v === "string" ? v : undefined;
  }

  num(k: string): number | undefined {
    const v = this.raw[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`\`${k}\` must be a number`);
    return v;
  }

  int(k: string, def: number, min: number, max: number): number {
    const v = this.raw[k];
    if (v === undefined || v === null) return def;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v >= min && v <= max) return v;
    throw bad(`\`${k}\` must be an integer from ${min} to ${max}`);
  }

  bool(k: string): boolean {
    const v = this.raw[k];
    if (v === undefined || v === null) return false;
    if (typeof v !== "boolean") throw bad(`\`${k}\` must be true or false`);
    return v;
  }

  oneOf(k: string, allowed: string[], def: string): string {
    const v = this.str(k) ?? def;
    if (!allowed.includes(v)) throw bad(`\`${k}\` must be one of ${allowed.join(", ")}`);
    return v;
  }

  id(k: string): string {
    const v = this.reqStr(k);
    if (!UUID.test(v)) throw bad(`\`${k}\` must be a UUID`);
    return v.toLowerCase();
  }

  optId(k: string): string | undefined {
    const v = this.str(k);
    if (v === undefined) return undefined;
    if (!UUID.test(v)) throw bad(`\`${k}\` must be a UUID`);
    return v.toLowerCase();
  }
}
