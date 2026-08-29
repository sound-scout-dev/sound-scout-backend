const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'soundscout_db',
  password: 'Ishakya.0809',
  port: 5432,
});

async function run() {
  const result = await pool.query("SELECT * FROM events WHERE organizer_id = 4");
  const dbEvents = result.rows;
  console.log("Fetched events count:", dbEvents.length);
  
  try {
      const mapped = dbEvents.map(e => {
          let parsedPlan;
          if (e.ai_infrastructure_plan) {
              parsedPlan = typeof e.ai_infrastructure_plan === 'string'
                ? JSON.parse(e.ai_infrastructure_plan)
                : e.ai_infrastructure_plan;
          }
          let displayPlan;
          if (parsedPlan && parsedPlan.categories) {
              displayPlan = parsedPlan;
          } else if (parsedPlan && (parsedPlan.budget_plan || parsedPlan.premium_plan)) {
              // noop
          } else {
              const min = e.budget_range ? String(e.budget_range).split('-')[0] : 50000;
              const max = e.budget_range ? String(e.budget_range).split('-')[1] : 150000;
          }
          return e.event_id;
      });
      console.log("Map success");
  } catch (err) {
      console.error("Map error:", err);
  }
  pool.end();
}
run();
