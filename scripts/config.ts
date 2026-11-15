import { appConfig } from '../config/app.ts';
const field = process.argv[2];
if (field && !(field in appConfig))
  throw new Error('Unknown configuration field');
console.log(
  field
    ? appConfig[field as keyof typeof appConfig]
    : JSON.stringify(appConfig, null, 2),
);
