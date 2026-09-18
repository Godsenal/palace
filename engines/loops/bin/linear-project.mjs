#!/usr/bin/env node
import { linearGql } from './linear-gql.mjs';

const [command = 'teams', teamId, ...nameParts] = process.argv.slice(2);
const key = process.env.LINEAR_API_KEY || '';
if (!key) { console.error('linear-project: LINEAR_API_KEY 필요'); process.exit(1); }
try {
  if (command === 'teams') {
    const data = await linearGql('query{ teams(first:100){ nodes{ id key name } } }', {}, key);
    process.stdout.write(`${JSON.stringify(data?.teams?.nodes || [], null, 2)}\n`);
  } else if (command === 'create') {
    const name = nameParts.join(' ').trim();
    if (!teamId || !name) { console.error('usage: linear-project.mjs create <teamId> <name>'); process.exit(1); }
    const viewer = await linearGql('query{ viewer{ id } }', {}, key);
    const data = await linearGql('mutation($name:String!,$teams:[String!]!,$lead:String){ projectCreate(input:{name:$name,teamIds:$teams,leadId:$lead}){ success project{ id name url } } }', { name, teams: [teamId], lead: viewer?.viewer?.id || null }, key);
    if (!data?.projectCreate?.success || !data.projectCreate.project) throw new Error('projectCreate 실패');
    process.stdout.write(`${data.projectCreate.project.id}\t${data.projectCreate.project.url}\n`);
  } else {
    console.error('usage: linear-project.mjs teams | create <teamId> <name>'); process.exit(1);
  }
} catch (error) { console.error(`linear-project: ${error.message}`); process.exit(1); }
