import { sql } from 'kysely';

/** Same receipt eligibility for provider and direct aggregate joins. */
export const publishedAnnualPopulation = sql`(
  select p.* from core.population_annual p
  join etl.load_runs r on r.run_id=p.load_run_id and r.status='succeeded'
    and r.source_id='core_reference_population_annual' and r.target_table='core.population_annual'
)`;
