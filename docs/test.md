1. Проверка, что всё работает (несколько секунд):
npm run browser:check -- --open https://www.linkedin.com/jobs/
npm run score -- --user illia.herasymets@gmail.com --limit 1 --dry-run
Если в выводе есть строка профиль rev N, связь с Job-Tracker работает.

2. Сбор вакансий (2–4 минуты):
npm run collect -- --user illia.herasymets@gmail.com --source linkedin \
  --query "node.js" --location Remote \
  --include "node,typescript,javascript,full stack,fullstack,backend,frontend,software engineer" \
  --exclude "java,android,ios,c++,qa,data engineer,machine learning,devops,sap,abap"

3. Оценка qwen без отправки в Job-Tracker (примерно 14 секунд на вакансию):
npm run score -- --user illia.herasymets@gmail.com --no-push
Каждая вакансия печатается отдельной строкой: + 75 … значит «в очередь», − 30 … значит «отклонена»,
после двоеточия причина. Если сначала хочешь посмотреть на 5 вакансиях, добавь --limit 5 --dry-run.

4. Посмотреть результат из базы:
cd server && node -e '
const db = require("better-sqlite3")("data/job-autopilot.db", { readonly: true });
console.table(db.prepare("select status, count(*) n from jobs group by status").all());
for (const j of db.prepare("select score, title, company, why, url from jobs where status = ? order by score desc").all(process.argv[1]))
  console.log(`${j.score}  ${j.title} — ${j.company}\n     ${j.why}\n     ${j.url}`);
' queued; cd ..
Сначала выводится, сколько вакансий в каждом статусе, потом сами вакансии, от лучшей оценки к худшей. Вместо queued в конце подставь rejected, чтобы посмотреть отклонённые и причины.

5. Отправить отобранное в Job-Tracker (если устраивает):
npm run score -- --user illia.herasymets@gmail.com
После этого вакансии должны появиться в Job-Tracker в списке To Apply.
