#!/usr/bin/env node
import { linearGql } from './linear-gql.mjs';

const id = process.argv[2];
const key = process.env.LINEAR_API_KEY || '';
if (!id || !key) { console.error('usage: LINEAR_API_KEY=… linear-issue.mjs <identifier>'); process.exit(1); }
try {
  const data = await linearGql(`query($id:String!){ issue(id:$id){ id identifier title description url priority state{ name type } labels{ nodes{ name } } attachments{ nodes{ id title url sourceType metadata } } comments(first:100){ nodes{ id body createdAt user{ name } } } } }`, { id }, key);
  if (!data?.issue) { console.error(`linear-issue: 이슈 ${id} 없음`); process.exit(1); }
  process.stdout.write(`${JSON.stringify(data.issue, null, 2)}\n`);
} catch (error) { console.error(`linear-issue: ${error.message}`); process.exit(1); }
