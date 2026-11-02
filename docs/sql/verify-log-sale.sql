-- Verify public.log_sale against the linked database WITHOUT leaving data behind.
--
-- It picks an owner whose shop has a product with stock >= 2, simulates that
-- user's JWT with set_config('request.jwt.claims', ...), calls log_sale twice
-- with the same batch id, asserts one sale row + one stock decrement +
-- already_applied on replay, and rolls the whole transaction back.
--
-- Run from the keel repo:
--   supabase db query --file <this file> --linked --output-format json
-- Expected: {"result": "log_sale test passed"}

begin;

do $$
declare
  v_user public.users;
  v_product public.products;
  v_batch uuid := gen_random_uuid();
  v_before integer;
  v_after integer;
  v_first jsonb;
  v_second jsonb;
  v_count integer;
begin
  select u.* into v_user
    from public.users u
   where u.role = 'owner'
     and exists (
       select 1 from public.products p
        where p.shop_id = u.shop_id and p.stock >= 2
     )
   limit 1;

  if v_user.id is null then
    raise exception 'No owner/shop/product with stock >= 2 available for the test';
  end if;

  select p.* into v_product
    from public.products p
   where p.shop_id = v_user.shop_id and p.stock >= 2
   limit 1;

  v_before := v_product.stock;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user.auth_user_id, 'role', 'authenticated')::text,
    true
  );

  v_first := public.log_sale(
    v_user.shop_id,
    v_batch,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'quantity', 2,
      'amount', 100
    )),
    'Cash',
    null,
    v_user.id,
    now()
  );

  select p.stock into v_after from public.products p where p.id = v_product.id;
  select count(*) into v_count
    from public.sales
   where shop_id = v_user.shop_id and batch_id = v_batch;

  if (v_first->>'already_applied')::boolean is not false then
    raise exception 'First call should not be already_applied: %', v_first;
  end if;
  if v_count <> 1 then
    raise exception 'Expected 1 sale row, got %', v_count;
  end if;
  if v_after <> v_before - 2 then
    raise exception 'Stock should be % but is %', v_before - 2, v_after;
  end if;

  v_second := public.log_sale(
    v_user.shop_id,
    v_batch,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'quantity', 2,
      'amount', 100
    )),
    'Cash',
    null,
    v_user.id,
    now()
  );

  select p.stock into v_after from public.products p where p.id = v_product.id;
  select count(*) into v_count
    from public.sales
   where shop_id = v_user.shop_id and batch_id = v_batch;

  if (v_second->>'already_applied')::boolean is not true then
    raise exception 'Replay should be already_applied: %', v_second;
  end if;
  if v_count <> 1 then
    raise exception 'Replay inserted a duplicate: % rows', v_count;
  end if;
  if v_after <> v_before - 2 then
    raise exception 'Replay decremented stock again: % -> %', v_before, v_after;
  end if;

  raise notice 'log_sale test passed for shop % (stock % -> %)',
    v_user.shop_id, v_before, v_after;
end;
$$;

select 'log_sale test passed' as result;

rollback;
