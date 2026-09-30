// A DynamoDB client double for the dynamo store tests: records every command
// (`name`, `input`) and answers from a tiny in-memory table model that knows
// just enough of PutItem / UpdateItem (SET a = :v, REMOVE a, if_not_exists)
// / GetItem / Query (partition key equality) / BatchGetItem / DeleteItem for
// the stores' round trips. Conditions are not evaluated unless `failNext`
// names a ConditionalCheckFailedException. It is NOT DynamoDB — the
// integration test against DynamoDB Local is the semantic check.

export interface SentCommand { name: string; input: any }

type Item = Record<string, any>;

export function makeDdbDouble(opts: { keys?: Record<string, [string, string]> } = {}) {
    const sent: SentCommand[] = [];
    const tables = new Map<string, Map<string, Item>>();
    const keyOf: Record<string, [string, string]> = {
        'chat-messages': ['channelId', 'messageId'],
        'chat-conversations': ['userId', 'channel'],
        'chat-members': ['channel', 'userId'],
        'chat-reads': ['channel', 'userId'],
        ...(opts.keys ?? {}),
    };
    const failures: Array<{ name: string; error: any }> = [];
    const responses: Array<{ name: string; response: any }> = [];

    const table = (t: string) => {
        let m = tables.get(t);
        if (!m) { m = new Map(); tables.set(t, m); }
        return m;
    };
    const k = (t: string, key: Item) => {
        const [pk, sk] = keyOf[t] ?? Object.keys(key);
        return `${key[pk]?.S}\u0000${key[sk]?.S}`;
    };

    function applyUpdate(item: Item, expr: string, names: Record<string, string> = {}, values: Record<string, any> = {}) {
        const n = (s: string) => names[s.trim()] ?? s.trim();
        const [setPart, removePart] = expr.replace(/^SET\s+/, '').split(/\s+REMOVE\s+/);
        for (const clause of setPart.split(/,(?![^(]*\))/)) {
            const [lhs, rhs] = clause.split('=').map((s) => s.trim());
            const ine = /^if_not_exists\(\s*([^,]+),\s*(:[\w]+)\s*\)$/.exec(rhs);
            if (ine) { if (item[n(lhs)] === undefined) item[n(lhs)] = values[ine[2]]; } else item[n(lhs)] = values[rhs];
        }
        if (removePart) for (const a of removePart.split(',')) delete item[n(a)];
    }

    const send = async (cmd: any) => {
        const name = cmd.constructor.name as string;
        const input = cmd.input;
        sent.push({ name, input: JSON.parse(JSON.stringify(input)) });
        const fi = failures.findIndex((f) => f.name === name);
        if (fi >= 0) { const [f] = failures.splice(fi, 1); throw f.error; }
        const ri = responses.findIndex((r) => r.name === name);
        if (ri >= 0) { const [r] = responses.splice(ri, 1); return r.response; }
        const t = input.TableName as string;
        switch (name) {
            case 'PutItemCommand': table(t).set(k(t, input.Item), { ...input.Item }); return {};
            case 'UpdateItemCommand': {
                const id = k(t, input.Key);
                const exists = table(t).has(id);
                if (input.ConditionExpression?.startsWith('attribute_exists') && !exists) {
                    const e: any = new Error('The conditional request failed'); e.name = 'ConditionalCheckFailedException'; throw e;
                }
                const item = { ...(table(t).get(id) ?? input.Key) };
                applyUpdate(item, input.UpdateExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues);
                table(t).set(id, item);
                return input.ReturnValues === 'ALL_NEW' ? { Attributes: { ...item } } : {};
            }
            case 'GetItemCommand': { const it = table(t).get(k(t, input.Key)); return it ? { Item: { ...it } } : {}; }
            case 'DeleteItemCommand': table(t).delete(k(t, input.Key)); return {};
            case 'QueryCommand': {
                const v = Object.values(input.ExpressionAttributeValues)[0] as any;
                const attr = input.IndexName ? 'channel' : (keyOf[t] ?? [])[0];
                let items = [...table(t).values()].filter((i) => i[attr]?.S === v.S);
                if (input.ScanIndexForward === false) items = items.reverse();
                if (input.Limit) items = items.slice(0, input.Limit);
                return { Items: items };
            }
            case 'BatchGetItemCommand': {
                const out: Record<string, Item[]> = {};
                for (const [tn, req] of Object.entries<any>(input.RequestItems)) {
                    out[tn] = req.Keys.map((key: Item) => table(tn).get(k(tn, key))).filter(Boolean);
                }
                return { Responses: out };
            }
            default: return {};
        }
    };

    return {
        send,
        sent,
        tables,
        rows: (t: string) => [...table(t).values()],
        row: (t: string, pk: string, sk: string) => [...table(t).values()].find((i) => {
            const [a, b] = keyOf[t]; return i[a]?.S === pk && i[b]?.S === sk;
        }),
        failNext(name: string, error: any) { failures.push({ name, error }); },
        respondNext(name: string, response: any) { responses.push({ name, response }); },
        clear() { sent.length = 0; },
    };
}

export const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
