/**
 * The data platform's DDL for the contract-award public views (PROC-KB0Z), for the
 * e2e throwaway. GENERATED from scrapper origin/main 9282fac0e by
 * scripts/procurement-ca-public-views-ddl.ts (rendering the migrations' up() SQL);
 * do not edit by hand.
 *
 * - CA_PLATFORM_TABLES: verbatim `create table` statements of
 *   20261121T090000__procurement_v3_tables (da_buyer_geography, supplier_privacy, ca_publications, ca_lots, ca_contract_lots, ca_contract_winners, ca_contract_identity, ca_money_facts) and its ca_contract_identity_match_idx.
 * - CA_NAMING_DDL: verbatim procurement_v3.mask_person_name (20261121T090096),
 *   mask_supplier_text and the supplier_naming table (20261124T120000; its
 *   truncate trigger left out).
 * - CA_PUBLIC_VIEWS_DDL: the whole of 20261124T120040's up(), the four views and
 *   their comments, character for character.
 *
 * Not verbatim (the stubs in the test): core.cui_is_mintable's checksum over a digits-only
 * normalize_cui, and minimal core.organizations and companies_v2.onrc_current_profiles with the
 * columns the views read.
 */

export const CA_PLATFORM_TABLES = String.raw`
    create table procurement_v3.da_buyer_geography (
      authority_cui text primary key,
      territorial_siruta_code text,
      county_code text,
      region text,
      copied_at timestamptz
    );
    create table procurement_v3.supplier_privacy (
      fiscal_code_clean text primary key,
      supplier_id bigint generated always as identity constraint supplier_privacy_supplier_id_key unique,
      supplier_kind text not null
        constraint supplier_privacy_supplier_kind_check
        check (supplier_kind in ('company', 'sole_trader', 'natural_person', 'unverified')),
      public boolean not null,
      method text not null,
      classified_at timestamptz,
      constraint supplier_privacy_supplier_id_check check (supplier_id > 0),
      -- A valid Romanian company code as the fast lane cleans it: digits, no leading zero, 2-10 long, checksum.
      constraint supplier_privacy_code_check check (
        fiscal_code_clean ~ '^[1-9][0-9]{1,9}$' and core.cui_is_mintable(fiscal_code_clean)),
      -- D6: only a company is public.
      constraint supplier_privacy_public_check check (not public or supplier_kind = 'company')
    );
    create table procurement_v3.ca_publications (
      source_name text not null,
      publication_id text not null,
      family text not null,
      public_id text not null constraint ca_publications_public_id_key unique,
      raw_item_ref bigint not null,
      raw_item_key text not null,
      -- The notice's public portal page (owner decision of 20 Nov 2026: every served row links to its source). Not null
      -- here, nullable in the workshop: the copy loads only built rows, and 430 stops on a null link before publication.
      source_url text not null,
      notice_id text,
      notice_no text,
      notice_no_status text not null,
      notice_type_id integer,
      notice_version_id integer,
      -- The list payload's contractTitle as served: labelled by the free-text rule, never hidden whole, never the
      -- text as written (raw keeps it). Null when the source has none.
      title text,
      listing_status text not null,
      listed_day date,
      publication_at timestamptz,
      publication_at_status text not null,
      publication_day date,
      list_state_id integer,
      raw_state_id integer,
      view_part text,
      view_status text,
      view_state_id integer,
      view_withdrawn boolean,
      view_notice_no text,
      view_notice_no_status text,
      view_notice_id text,
      kind text,
      view_kind_flags jsonb,
      service_view_kind_flags jsonb,
      view_parent_ca_notice_id text,
      versions_parent_ca_notice_id text,
      chain_reference text not null,
      chain_member_ids text[],
      previous_publication_notice_id text,
      previous_publication_notice_type_id integer,
      procedure_id text,
      procedure_id_status text not null,
      procedure_type_id integer,
      procedure_state_id integer,
      contract_type_id integer,
      assignment_type_id integer,
      is_online boolean,
      is_utility boolean,
      is_ppp boolean,
      has_subsequent_contracts boolean,
      category_code text,
      category_code_status text not null,
      list_value numeric,
      list_value_status text not null,
      view_total numeric,
      view_total_status text,
      view_total_lei numeric,
      view_total_lei_status text,
      view_framework_value numeric,
      view_framework_value_status text,
      view_currency_id integer,
      list_view_agree text not null,
      list_view_differences text[] not null,
      buyer_fiscal_code_clean text,
      buyer_fiscal_code_status text not null,
      view_buyer_entity_id text,
      view_buyer_address jsonb,
      view_buyer_code_clean text,
      view_buyer_code_status text,
      buyer_link text,
      buyer_party_eligible boolean,
      expected_rule_version text not null,
      parts_gated_reason text,
      part_summary jsonb not null,
      list_payload_key text not null,
      list_content_since timestamptz,
      view_retrieved_at timestamptz,
      primary key (source_name, publication_id),
      constraint ca_publications_source_raw_item_ref_key unique (source_name, raw_item_ref)
    );
    create table procurement_v3.ca_lots (
      source_name text not null,
      publication_id text not null,
      lot_id text not null,
      lot_order integer not null,
      lot_number text,
      lot_number_status text not null,
      -- The lots part's contractTitle of the lot as served, labelled, as ca_publications.title.
      title text,
      category_code text,
      category_code_status text not null,
      estimated_value numeric,
      estimated_value_status text,
      min_estimated_value numeric,
      min_estimated_value_status text,
      max_estimated_value numeric,
      max_estimated_value_status text,
      currency_id integer,
      award_criteria_id integer,
      is_eu_funded boolean,
      has_options boolean,
      ted_uid text,
      ted_uid_status text not null,
      cancelled_status text not null,
      cancelled_page integer,
      cancellation_at timestamptz,
      cancellation_at_status text not null,
      cancelled_at_procedure_level boolean,
      superseded_at timestamptz,
      primary key (source_name, publication_id, lot_id)
    );
    create table procurement_v3.ca_contract_lots (
      source_name text not null,
      publication_id text not null,
      contract_id text not null,
      lot_id text not null,
      lot_order integer not null,
      lot_no text,
      lot_no_status text not null,
      procedure_lot_id text,
      in_publication_lots boolean,
      superseded_at timestamptz,
      primary key (source_name, publication_id, contract_id, lot_id)
    );
    create table procurement_v3.ca_contract_winners (
      source_name text not null,
      publication_id text not null,
      contract_id text not null,
      winner_key text not null,
      page_order integer,
      view_order integer,
      page_row_id text,
      page_entity_id text,
      page_code_clean text,
      page_code_status text,
      page_address jsonb,
      view_entity_id text,
      view_code_clean text,
      view_code_status text,
      view_address jsonb,
      link_status text not null,
      unmatched_side text,
      unmatched_reason text,
      portal_party_id text,
      party_eligible boolean not null,
      party_variants integer,
      superseded_at timestamptz,
      primary key (source_name, publication_id, contract_id, winner_key)
    );
    create table procurement_v3.ca_contract_identity (
      source_name text not null,
      publication_id text not null,
      contract_id text not null,
      contract_kind text constraint ca_contract_identity_contract_kind_check
        check (contract_kind in ('plain_contract', 'framework_agreement', 'subsequent_contract')),
      match_id text not null,
      match_status text not null
        constraint ca_contract_identity_match_status_check check (match_status in ('linked', 'single', 'review')),
      match_method text not null constraint ca_contract_identity_match_method_check
        check (match_method in ('anchor', 'number_day', 'explicit_history', 'none')),
      predecessor_publication_id text,
      predecessor_contract_id text,
      chain_rank integer,
      identity_status text not null constraint ca_contract_identity_identity_status_check
        check (identity_status in ('eligible', 'unverified_head', 'identity_review', 'collection_review',
          'cancellation_review', 'not_at_head', 'head_review', 'withdrawn_or_dropped')),
      current_status text not null constraint ca_contract_identity_current_status_check
        check (current_status in ('eligible', 'unverified_head', 'identity_review', 'collection_review',
          'cancellation_review', 'not_at_head', 'head_review', 'withdrawn_or_dropped', 'superseded')),
      is_current boolean not null,
      review_reasons text[] not null constraint ca_contract_identity_review_reasons_check
        check (review_reasons <@ array['repeated_within_publication', 'incompatible_kind_winner_buyer',
          'unverified_order_or_collection', 'reappears_after_observed_omission', 'missing_number_date',
          'conflicting_source_fields', 'cross_chain_unknown_procedure', 'cross_notice_number_date',
          'history_conflict_or_unverified', 'possible_corrected_key', 'transitive_conflict']::text[]),
      members integer not null constraint ca_contract_identity_members_check check (members >= 1),
      gap_to_predecessor boolean not null,
      chain_history_incomplete boolean not null,
      chain_order_unverified boolean not null,
      primary key (source_name, publication_id, contract_id),
      -- 430 identity_status_not_one_per_identity: the current appearance carries the identity's status, another one
      -- superseded or withdrawn_or_dropped; a single appearance has no method, a linked one has several members.
      constraint ca_contract_identity_current_check check (
        case when is_current then current_status = identity_status
          else current_status in ('superseded', 'withdrawn_or_dropped') end),
      constraint ca_contract_identity_members_method_check check (
        (match_method = 'none') = (members = 1) and (match_status <> 'linked' or members > 1)
        and (match_status <> 'single' or members = 1))
    );
    create table procurement_v3.ca_money_facts (
      source_name text not null,
      match_id text not null,
      value_kind text not null constraint ca_money_facts_value_kind_check
        check (value_kind in ('awarded', 'framework_ceiling', 'modification_change')),
      contract_kind text constraint ca_money_facts_contract_kind_check
        check (contract_kind in ('plain_contract', 'framework_agreement', 'subsequent_contract')),
      current_status text not null constraint ca_money_facts_current_status_check
        check (current_status in ('eligible', 'unverified_head', 'identity_review', 'superseded')),
      head_status text not null constraint ca_money_facts_head_status_check
        check (head_status in ('named_head', 'unverified_head', 'not_at_head', 'collection_review',
          'cancellation_review', 'head_review')),
      current_publication_id text not null,
      current_contract_id text not null,
      evidence_publication_id text not null,
      evidence_contract_id text not null,
      before_publication_id text,
      before_contract_id text,
      native_amount numeric,
      currency_id integer,
      exchange_rate numeric,
      reported_ron numeric,
      amount_source text not null constraint ca_money_facts_amount_source_check
        check (amount_source in ('view_ron', 'page_ron', 'ceiling_native_ron', 'ceiling_portal_fx',
          'ceiling_unconverted', 'page_ceiling_proxy', 'page_ceiling_fx_proxy', 'page_ceiling_unconverted', 'missing',
          'view_ron_change', 'ceiling_change', 'not_measured')),
      additive_ron numeric,
      review_exposure_ron numeric,
      vat_basis text not null constraint ca_money_facts_vat_basis_check check (vat_basis = 'unknown'),
      conclusion_day date,
      publication_day date,
      notice_kind text constraint ca_money_facts_notice_kind_check
        check (notice_kind in ('original', 'completion', 'modification', 'correction', 'ambiguous')),
      procedure_id text,
      buyer_code text,
      buyer_entity_id text,
      category_code text,
      members integer not null constraint ca_money_facts_members_check check (members >= 1),
      flag_page_value boolean not null,
      flag_list_value boolean not null,
      flag_foreign_lei_equivalent boolean not null,
      flag_zero boolean not null,
      flag_negative boolean not null,
      flag_currency_unknown boolean not null,
      flag_rate_unknown boolean not null,
      flag_native_ron_disagrees boolean not null,
      flag_unverified_head boolean not null,
      flag_history_incomplete boolean not null,
      flag_kind_unknown boolean not null,
      flag_change_carried boolean not null,
      superseded_at timestamptz,
      primary key (source_name, match_id, value_kind),
      -- 430 money_review_additive: a review fact is never additive and carries its amount as exposure; a superseded
      -- fact is never additive; any other fact's additive amount is its reported one.
      constraint ca_money_facts_additive_check check (
        case when current_status in ('identity_review', 'superseded') then additive_ron is null
          else review_exposure_ron is null and additive_ron is not distinct from reported_ron end),
      -- A fact is superseded exactly when it is marked.
      constraint ca_money_facts_superseded_check check ((current_status = 'superseded') = (superseded_at is not null)),
      -- 430 money_fact_without_representative: a framework agreement's fact is its ceiling, any other contract's its
      -- awarded value (a change fact aside).
      constraint ca_money_facts_value_kind_contract_check check (
        value_kind = 'modification_change'
        or value_kind = case when contract_kind = 'framework_agreement' then 'framework_ceiling' else 'awarded' end),
      constraint ca_money_facts_change_check check (
        value_kind <> 'modification_change' or current_status <> 'identity_review')
    );
    create index ca_contract_identity_match_idx on procurement_v3.ca_contract_identity (match_id);
`;

export const CA_NAMING_DDL = String.raw`
    create function procurement_v3.mask_person_name(name text) returns text
    language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp as $f$
      select string_agg(
        case when char_length(x.core) <= 3
            or upper(translate(x.core, 'ĂăÂâÎîȘșŞşȚțŢţ', 'AaAaIiSsSsTtTt')) collate "pg_c_utf8"
              ~ '^(INTREPRINDEREA?|INDIVIDUALA|FAMILIALA|P\.?F\.?A\.?|I\.?I\.?|I\.?F\.?|PERSOANA|FIZICA|AUTORIZATA)$'
          then s.word
          else x.pre || left(x.core, 2) || repeat('*', char_length(x.core) - 3) || right(x.core, 1) || x.post end,
        ' ' order by s.n)
      from regexp_split_to_table(btrim(normalize(name, NFC)) collate "pg_c_utf8", '\s+') with ordinality s(word, n)
      cross join lateral (
        select m[1] as pre, m[2] as core, m[3] as post
        from regexp_match(s.word collate "pg_c_utf8", '^([^[:alnum:]]*)(.*?)([^[:alnum:]]*)$') m
      ) x
    $f$;
    create function procurement_v3.mask_supplier_text(t text) returns text
    language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp as $f$
      select case when regexp_replace(m.v collate "pg_c_utf8", '[^[:alpha:]]', '', 'g')
          <> regexp_replace(s.v collate "pg_c_utf8", '[^[:alpha:]]', '', 'g') then m.v end
      from (
        select btrim(regexp_replace(regexp_replace(
          regexp_replace(normalize(t, NFKC) collate "pg_unicode_fast", '[[:digit:]]', '', 'g'),
          '[^[:alpha:][:space:].,&()''"/-]', '', 'g'), '\s+', ' ', 'g')) as v
      ) s
      cross join lateral (
        select case when s.v collate "pg_c_utf8" ~ '[[:alpha:]]' then procurement_v3.mask_person_name(s.v) end as v
      ) m
    $f$;
    create table procurement_v3.supplier_naming (
      fiscal_code_clean text primary key
        constraint supplier_naming_code_check check (fiscal_code_clean ~ '^[1-9][0-9]{1,9}$'),
      lanes text[] not null
        constraint supplier_naming_lanes_check check (cardinality(lanes) > 0 and lanes <@ array['ca', 'da']),
      text_kind text,
      in_onrc boolean not null,
      onrc_edition_id bigint,
      onrc_eligibility text,
      onrc_reason text,
      onrc_legal_form text,
      registry_kind text,
      naming text not null
        constraint supplier_naming_naming_check check (naming in ('named', 'masked', 'code_only', 'withheld')),
      masked_name text,
      name_source text
        constraint supplier_naming_name_source_check check (name_source in ('registry', 'registry_masked', 'text_masked')),
      policy_version text not null,
      built_at timestamptz not null,
      constraint supplier_naming_onrc_check check (in_onrc or onrc_edition_id is null),
      constraint supplier_naming_masked_only_check check (masked_name is null or naming = 'masked'),
      constraint supplier_naming_masked_digit_check check (
        masked_name is null or (masked_name collate "pg_unicode_fast" !~ '[[:digit:]]' and masked_name !~ '[0-9]')),
      constraint supplier_naming_masked_source_check check (
        coalesce(name_source in ('registry_masked', 'text_masked'), false) = (masked_name is not null)),
      constraint supplier_naming_named_source_check check (
        coalesce(name_source = 'registry', false) = (naming = 'named'))
    );
`;

export const CA_PUBLIC_VIEWS_DDL = String.raw`

    create view procurement_v3.ca_records_public with (security_barrier = true) as
    select f.source_name, f.match_id, f.source_name || ':' || f.match_id as record_id,
      case f.contract_kind when 'plain_contract' then 'ordinary' when 'subsequent_contract' then 'call_off'
        when 'framework_agreement' then 'framework_agreement' end as contract_kind,
      f.value_kind, f.additive_ron is not null as additive,
      case when f.current_status = 'identity_review' then 'identity_review' else 'awarded' end as status,
      case f.head_status when 'named_head' then 'confirmed' when 'unverified_head' then 'unverified' end
        as ca_head_status,
      m.amount_lei, m.native_amount,
      case when f.currency_id = 1 then 'RON' when f.currency_id is not null then 'portal:' || f.currency_id end
        as currency,
      case when m.amount_lei is not null then
        case when f.reported_ron is null then null when f.currency_id = 1 then 'native_ron' else 'portal_equivalent' end
      end as fx_source,
      f.vat_basis,
      case when f.amount_source in ('view_ron', 'ceiling_native_ron', 'ceiling_portal_fx', 'ceiling_unconverted',
          'view_ron_change', 'ceiling_change') then 'contract_view'
        when f.amount_source = 'page_ron' then 'contract_page'
        when left(f.amount_source, 12) = 'page_ceiling' then 'list_value' end as amount_origin,
      array_remove(array[case when f.flag_list_value then 'list_value' end,
        case when f.flag_page_value then 'page_value' end,
        case when f.flag_foreign_lei_equivalent then 'foreign_equivalent' end,
        case when f.flag_native_ron_disagrees then 'native_disagreement' end], null)
      || array_remove(array[
        case when coalesce(m.amount_lei, m.native_amount) = 0 then 'zero' end,
        case when coalesce(m.amount_lei, m.native_amount) < 0 then 'negative' end,
        case when (select count(*) from procurement_v3.ca_contract_winners w
      where w.source_name = f.source_name and w.publication_id = f.current_publication_id
        and w.contract_id = f.current_contract_id and w.superseded_at is null)::integer >= 2 then 'joint_win' end], null) as flags,
      (select case when abs(x.reported_ron) < 1e18 then x.reported_ron::numeric(20, 2) end
        from procurement_v3.ca_money_facts x
        where x.source_name = f.source_name and x.match_id = f.match_id and x.value_kind = 'modification_change'
          and x.superseded_at is null) as change_lei,
      (select ep.publication_day
        from procurement_v3.ca_money_facts x
        join procurement_v3.ca_publications ep
          on ep.source_name = x.source_name and ep.publication_id = x.evidence_publication_id
        where x.source_name = f.source_name and x.match_id = f.match_id and x.value_kind = 'modification_change'
          and x.superseded_at is null) as change_publication_day,
      f.conclusion_day as award_day, f.publication_day,
      f.buyer_code, g.county_code as buyer_county_code, g.territorial_siruta_code as buyer_siruta,
      g.region as buyer_region,
      (coalesce((select sp.supplier_kind in ('sole_trader', 'natural_person')
        from procurement_v3.supplier_privacy sp where sp.fiscal_code_clean = f.buyer_code), false)
      or exists (select 1 from companies_v2.onrc_current_profiles op
        where op.cui = f.buyer_code and op.eligibility_reason = 'natural_person_form' offset 0)
      or coalesce((select coalesce(btrim(regexp_replace(translate(regexp_replace(normalize(r.name, NFKD) collate "pg_c_utf8",
              '[̀-ͯ]', '', 'g'), 'ĂăÂâÎîȘșŞşȚțŢţ', 'AaAaIiSsSsTtTt'), '[^[:alnum:]]+', ' ', 'g'))
            ~* '(?<![[:alpha:]])p ?f ?a(?![[:alpha:]])|persoana ?fizica(?![[:alpha:]])|ntreprinderea? ?(individ|famil)',
          false) from (select coalesce(o.display_name, o.name) as name
      from core.organizations o
      where o.cui = f.buyer_code
        and o.privacy_class = 'public'
        and o.cui ~ '^[1-9][0-9]{1,9}$'
        and core.cui_is_mintable(o.cui)
        and not exists (select 1 from core.organizations d where d.cui = o.cui and d.org_id <> o.org_id)
      offset 0) r), false)) as buyer_person,
      case when (coalesce((select sp.supplier_kind in ('sole_trader', 'natural_person')
        from procurement_v3.supplier_privacy sp where sp.fiscal_code_clean = f.buyer_code), false)
      or exists (select 1 from companies_v2.onrc_current_profiles op
        where op.cui = f.buyer_code and op.eligibility_reason = 'natural_person_form' offset 0)
      or coalesce((select coalesce(btrim(regexp_replace(translate(regexp_replace(normalize(r.name, NFKD) collate "pg_c_utf8",
              '[̀-ͯ]', '', 'g'), 'ĂăÂâÎîȘșŞşȚțŢţ', 'AaAaIiSsSsTtTt'), '[^[:alnum:]]+', ' ', 'g'))
            ~* '(?<![[:alpha:]])p ?f ?a(?![[:alpha:]])|persoana ?fizica(?![[:alpha:]])|ntreprinderea? ?(individ|famil)',
          false) from (select coalesce(o.display_name, o.name) as name
      from core.organizations o
      where o.cui = f.buyer_code
        and o.privacy_class = 'public'
        and o.cui ~ '^[1-9][0-9]{1,9}$'
        and core.cui_is_mintable(o.cui)
        and not exists (select 1 from core.organizations d where d.cui = o.cui and d.org_id <> o.org_id)
      offset 0) r), false)) then
        (select procurement_v3.mask_supplier_text(r.name) from (select coalesce(o.display_name, o.name) as name
      from core.organizations o
      where o.cui = f.buyer_code
        and o.privacy_class = 'public'
        and o.cui ~ '^[1-9][0-9]{1,9}$'
        and core.cui_is_mintable(o.cui)
        and not exists (select 1 from core.organizations d where d.cui = o.cui and d.org_id <> o.org_id)
      offset 0) r) end
        as buyer_name_masked,
      k.cpv_code, left(k.digits, 2) as cpv_division, left(k.digits, 3) as cpv_group, left(k.digits, 4) as cpv_class,
      f.procedure_id, c.notice_no, c.title, c.source_url,
      (select count(*) from procurement_v3.ca_contract_winners w
      where w.source_name = f.source_name and w.publication_id = f.current_publication_id
        and w.contract_id = f.current_contract_id and w.superseded_at is null)::integer as winner_count,
      (select count(*) from procurement_v3.ca_contract_lots cl
      where cl.source_name = f.source_name and cl.publication_id = f.current_publication_id
        and cl.contract_id = f.current_contract_id and cl.superseded_at is null)::integer as lot_count
    from procurement_v3.ca_money_facts f
    cross join lateral (select
        case when abs(f.reported_ron) < 1e18 then f.reported_ron::numeric(20, 2) end as amount_lei,
        case when abs(f.native_amount) < 1e18 then f.native_amount::numeric(20, 2) end as native_amount) m
    cross join lateral (select f.category_code as cpv_code, substring(f.category_code from '^([0-9]{8})') as digits) k
    left join procurement_v3.ca_publications c
      on c.source_name = f.source_name and c.publication_id = f.current_publication_id
    left join procurement_v3.da_buyer_geography g on g.authority_cui = f.buyer_code
    where f.superseded_at is null and f.value_kind in ('awarded', 'framework_ceiling');

    create view procurement_v3.ca_record_winners_public with (security_barrier = true) as
    select f.source_name, f.match_id, coalesce(w.view_order, w.page_order) as winner_order, sn.fiscal_code_clean,
      case when sn.fiscal_code_clean is not null then exists (select 1 from procurement_v3.supplier_disclosure d
        where d.fiscal_code_clean = sn.fiscal_code_clean) end as supplier_disclosed
    from procurement_v3.ca_money_facts f
    join procurement_v3.ca_contract_winners w on w.source_name = f.source_name
      and w.publication_id = f.current_publication_id and w.contract_id = f.current_contract_id
      and w.superseded_at is null
    left join procurement_v3.supplier_naming sn on sn.fiscal_code_clean = (case when view_code_status = 'personal_code' or page_code_status = 'personal_code'
        then null
      when view_code_status = 'valid' and page_code_status = 'valid' then
        case when view_code_clean = page_code_clean then view_code_clean end
      when view_code_status = 'valid' then view_code_clean
      when page_code_status = 'valid' then page_code_clean end)
    where f.superseded_at is null and f.value_kind in ('awarded', 'framework_ceiling');

    create view procurement_v3.ca_record_lots_public with (security_barrier = true) as
    select f.source_name, f.match_id, cl.lot_order, cl.lot_no as lot_number, l.title, l.category_code as cpv_code,
      l.estimated_value,
      case when l.currency_id = 1 then 'RON' when l.currency_id is not null then 'portal:' || l.currency_id end
        as currency,
      l.is_eu_funded, l.cancelled_status
    from procurement_v3.ca_money_facts f
    join procurement_v3.ca_contract_lots cl on cl.source_name = f.source_name
      and cl.publication_id = f.current_publication_id and cl.contract_id = f.current_contract_id
      and cl.superseded_at is null
    left join procurement_v3.ca_lots l on l.source_name = cl.source_name and l.publication_id = cl.publication_id
      and l.lot_id = cl.lot_id and l.superseded_at is null
    where f.superseded_at is null and f.value_kind in ('awarded', 'framework_ceiling');

    create view procurement_v3.ca_record_keys_public with (security_barrier = true) as
    select i.source_name, i.publication_id, i.contract_id, i.match_id
    from procurement_v3.ca_contract_identity i
    where exists (select 1 from procurement_v3.ca_money_facts f
      where f.source_name = i.source_name and f.match_id = i.match_id and f.superseded_at is null and f.value_kind in ('awarded', 'framework_ceiling'));
  ;

comment on view procurement_v3.ca_records_public is 'Contract awards the API may show: one row per contract identity (its current awarded or framework_ceiling fact, the money_facts contract_award population for those value kinds), with money_facts'' expressions for every shared column, the current modification change and its publication day, the buyer''s code and place, whether the buyer is a person (D6 class, ONRC natural-person form, or a sole-trader marker in its registry name) with its registry name masked then, the CPV levels, the procedure, notice number, labelled title and portal page, and the counts of ca_record_winners_public and ca_record_lots_public. Not served: the contract number (never stored), other appearances, party ids, winner keys, addresses, any full registry or portal name. match_id is build-scoped. Source link: source_url (the current publication). Owner rights, security barrier; read grant approved separately.';

comment on view procurement_v3.ca_record_winners_public is 'Contract-award winners the API may show: one row per current winner row of a record''s current appearance (the rows equal ca_records_public.winner_count). fiscal_code_clean only when the winner''s code (view and page codes when valid and equal, else the valid one; none beside a personal code) has a supplier_naming row; names come by code from supplier_names_public. supplier_disclosed: the code is in supplier_disclosure, false when shown by code only, null when no code is shown. winner_order is a sort field and can tie. No winner key, party id, address or name. Source link: (source_name, match_id) -> ca_records_public.source_url. Owner rights, security barrier; read grant approved separately.';

comment on view procurement_v3.ca_record_lots_public is 'Contract-award lots the API may show: one row per current contract lot of a record''s current appearance (the rows equal ca_records_public.lot_count), with the publication''s current lot of the same id where there is one: labelled title, CPV, the estimate with its currency (an estimate, never in a total), EU funding and cancellation. Source link: (source_name, match_id) -> ca_records_public.source_url. Owner rights, security barrier; read grant approved separately.';

comment on view procurement_v3.ca_record_keys_public is 'Contract-award record keys: one row per appearance (source_name, publication_id, contract_id) of an identity ca_records_public serves, with the identity''s current match_id, so an old record_id (source_name:ca:publication:contract) finds today''s record after a re-anchoring. An appearance whose identity has no current fact has no row. Source link: (source_name, match_id) -> ca_records_public.source_url. Owner rights, security barrier; read grant approved separately.';
`;
