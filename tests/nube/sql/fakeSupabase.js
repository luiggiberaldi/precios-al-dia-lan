/**
 * Cliente «tipo Supabase» sobre PGlite para probar src/nube contra el SQL real.
 * Implementa lo que usa la app: auth (sesión anónima, correo y clave), rpc() con
 * argumentos con nombre y from().select().eq().is().order().limit().
 * Cada operación corre como el usuario de la sesión (RLS reales).
 */
import { createUser, as } from './harness.js';

function sqlIdent(name) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`identificador inválido: ${name}`);
    return name;
}

/**
 * Como PostgREST: las horas llegan como texto ISO con microsegundos
 * («2026-11-16T10:00:00.123456+00:00»), no como Date de JS (que corta en milisegundos).
 */
const toIso = (v) => v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
const TIMESTAMP_AS_TEXT = { 1184: toIso, 1114: toIso };

class Query {
    constructor(client, table) {
        this.client = client;
        this.table = sqlIdent(table);
        this.cols = '*';
        this.where = [];
        this.params = [];
        this.orderBy = [];
        this.max = null;
    }
    select(cols = '*') { this.cols = cols.split(',').map((c) => sqlIdent(c.trim())).join(', '); return this; }
    eq(col, val) { this.params.push(val); this.where.push(`${sqlIdent(col)} = $${this.params.length}`); return this; }
    gt(col, val) { this.params.push(val); this.where.push(`${sqlIdent(col)} > $${this.params.length}`); return this; }
    is(col, val) { if (val !== null) throw new Error('is() solo con null'); this.where.push(`${sqlIdent(col)} is null`); return this; }
    order(col, { ascending = true } = {}) { this.orderBy.push(`${sqlIdent(col)}${ascending ? '' : ' desc'}`); return this; }
    limit(n) { this.max = Number(n); return this; }
    async run() {
        let sql = `select ${this.cols} from public.${this.table}`;
        if (this.where.length) sql += ` where ${this.where.join(' and ')}`;
        if (this.orderBy.length) sql += ` order by ${this.orderBy.join(', ')}`;
        if (this.max) sql += ` limit ${this.max}`;
        try {
            const rows = await as(this.client.db, this.client.user, async (tx) => (await tx.query(sql, this.params, { parsers: TIMESTAMP_AS_TEXT })).rows);
            return { data: rows, error: null };
        } catch (error) {
            return { data: null, error: { message: error.message, code: error.code } };
        }
    }
    then(resolve, reject) { return this.run().then(resolve, reject); }
}

export class FakeSupabase {
    constructor(db, { accounts = new Map() } = {}) {
        this.db = db;
        this.user = null;
        this.accounts = accounts; // email → { id, password } (compartido entre clientes)
        const self = this;
        this.auth = {
            async getSession() { return { data: { session: self.user ? { user: { id: self.user.id } } : null } }; },
            async signInAnonymously() {
                self.user = await createUser(db, { anonymous: true });
                return { data: { user: { id: self.user.id } }, error: null };
            },
            async signUp({ email, password }) {
                if (self.accounts.has(email)) return { data: {}, error: { message: 'User already registered' } };
                const u = await createUser(db, { email });
                self.accounts.set(email, { id: u.id, password });
                self.user = u;
                return { data: { user: { id: u.id }, session: { user: { id: u.id } } }, error: null };
            },
            async signInWithPassword({ email, password }) {
                const acc = self.accounts.get(email);
                if (!acc || acc.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
                self.user = { id: acc.id, anonymous: false };
                return { data: { user: { id: acc.id } }, error: null };
            },
            async signOut() { self.user = null; return { error: null }; },
        };
    }

    from(table) { return new Query(this, table); }

    async rpc(fn, args = {}) {
        const names = Object.keys(args).map(sqlIdent);
        const placeholders = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
        const sql = `select * from public.${sqlIdent(fn)}(${placeholders})`;
        try {
            const rows = await as(this.db, this.user, async (tx) => (await tx.query(sql, names.map((n) => args[n]))).rows);
            // Las funciones escalares devuelven una columna con el nombre de la función.
            if (rows.length === 1 && Object.keys(rows[0]).length === 1 && fn in rows[0]) return { data: rows[0][fn], error: null };
            if (rows.length === 1 && Object.values(rows[0]).every((v) => v === null)) return { data: null, error: null };
            return { data: rows, error: null };
        } catch (error) {
            return { data: null, error: { message: error.message, code: error.code } };
        }
    }
}
