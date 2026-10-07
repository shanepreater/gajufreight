%%% @doc Tests needing no network: builds match Hakuzaru's, hashes match the chain's
%%% (spike E8), events decode, and the HTTP layer routes and reports errors. They run on
%%% the spike's probe contracts, which compile to known shapes (contracts/spike).
-module(tx_builder_tests).

-include_lib("eunit/include/eunit.hrl").
-include_lib("inets/include/httpd.hrl").

-define(CALLER, "ak_2h9aNfyyD3VNnS8NJqxJUkr8F1qdxWjh3NHSxuX51TbR24feig").
-define(BOOKER, "ct_QWM9Btm6yfg6s3xN7fg5hb4pv4QyfyksSpcLeDXY9EwuQ5N1V").
-define(TEMPLATE, "ct_D49yFRtcTMPgkcUCyyL7H69nc4Gpi2bMEEoGVt9BSerGTfKt1").

setup() ->
    ok = application:load(tx_builder),
    ok = tx_builder_contracts:load(os:getenv("TX_BUILDER_CONTRACTS")).

tx_builder_test_() ->
    {setup, fun setup/0, fun(_) -> application:unload(tx_builder) end,
     [fun call_is_what_hakuzaru_builds/0,
      fun create_is_what_hakuzaru_builds/0,
      fun hash_reproduces_the_chain/0,
      fun several_parts_hash_as_a_tuple/0,
      fun events_decode_by_topic/0,
      fun unknown_names_are_errors/0,
      fun http_health_and_hash/0,
      fun http_rejects_bad_requests/0]}.

book_args() ->
    [?TEMPLATE, ?CALLER, ?CALLER, "[]", "[" ++ ?CALLER ++ "]", "1000"].

call_is_what_hakuzaru_builds() ->
    Req = #{contract => ?BOOKER, contract_name => <<"probe-booker">>, function => "book",
            args => book_args(), caller => ?CALLER, amount => 7, nonce => 3, ttl => 999999,
            dry_run => false},
    {ok, #{tx := Tx, nonce := 3, ttl := 999999, dry_run_gas := null, fee_estimate := null}} =
        tx_builder_calls:call(Req),
    {ok, #{aaci := AACI}} = tx_builder_contracts:get(<<"probe-booker">>),
    ?assertEqual(hz:contract_call(?CALLER, 3, 5000000, 1000000000, 7, 999999, AACI, ?BOOKER,
                                  "book", {sophia, book_args()}),
                 {ok, Tx}).

create_is_what_hakuzaru_builds() ->
    Req = #{contract_name => <<"probe-escrow">>, args => ["1000"], caller => ?CALLER,
            amount => 1000, nonce => 4, ttl => 999999, dry_run => false},
    {ok, #{tx := Tx}} = tx_builder_calls:create(Req),
    {ok, #{built := Built}} = tx_builder_contracts:get(<<"probe-escrow">>),
    ?assertEqual(hz:contract_create_built(?CALLER, 4, 5000000, 1000000000, 1000, 999999, Built,
                                          {sophia, ["1000"]}),
                 {ok, Tx}).

%% Spike E8: the contract's Crypto.blake2b of this record matched the off-chain hash of
%% its FATE serialisation, {tuple, {100, <<"NLRTM">>}}.
hash_reproduces_the_chain() ->
    {ok, #{hash := Hash}} = tx_builder_fate:hash([part(<<"probe-escrow">>, "fingerprint", "t",
                                                       "{price = 100, location = \"NLRTM\"}")]),
    {ok, Expected} = eblake2:blake2b(32, gmb_fate_encoding:serialize({tuple, {100, <<"NLRTM">>}})),
    ?assertEqual(<<"#", (binary:encode_hex(Expected, lowercase))/binary>>, Hash).

several_parts_hash_as_a_tuple() ->
    Manifest = "#" ++ lists:duplicate(64, $a),
    {ok, #{hash := Hash}} = tx_builder_fate:hash([part(<<"probe-sized-escrow">>, "init", "manifest", Manifest),
                                                  part(<<"probe-sized-escrow">>, "init", "consignee", ?CALLER)]),
    {ok, <<_:8, Pub/binary>> = _} = {ok, <<0, (element(2, gmser_api_encoder:decode(list_to_binary(?CALLER))))/binary>>},
    Value = {tuple, {{bytes, binary:copy(<<16#aa>>, 32)}, {address, Pub}}},
    {ok, Expected} = eblake2:blake2b(32, gmb_fate_encoding:serialize(Value)),
    ?assertEqual(<<"#", (binary:encode_hex(Expected, lowercase))/binary>>, Hash).

events_decode_by_topic() ->
    {account_pubkey, Pub} = gmser_api_encoder:decode(list_to_binary(?CALLER)),
    Location = gmser_api_encoder:encode(contract_bytearray, <<"NLRTM">>),
    Log = [#{<<"address">> => <<"ct_x">>, <<"topics">> => [tx_builder_fate:topic(<<"RefundPaid">>), 12345],
             <<"data">> => <<"cb_Xfbg4g==">>},
           #{<<"address">> => <<"ct_x">>,
             <<"topics">> => [tx_builder_fate:topic(<<"CheckpointAdded">>), binary:decode_unsigned(Pub), 1, 255],
             <<"data">> => Location},
           #{<<"address">> => <<"ct_x">>, <<"topics">> => [42], <<"data">> => <<"cb_Xfbg4g==">>}],
    {ok, [Refund, Checkpoint, Unknown]} = tx_builder_fate:decode_events(<<"probe-sized-escrow">>, Log),
    ?assertMatch(#{event := <<"RefundPaid">>, fields := [12345]}, Refund),
    ?assertMatch(#{event := <<"CheckpointAdded">>, fields := [_, 1, _, <<"NLRTM">>]}, Checkpoint),
    #{fields := [Who, _, Evidence, _]} = Checkpoint,
    ?assertEqual(list_to_binary(?CALLER), Who),
    ?assertEqual(<<"#", (binary:copy(<<"0">>, 62))/binary, "ff">>, Evidence),
    ?assertMatch(#{event := null}, Unknown).

unknown_names_are_errors() ->
    ?assertEqual({error, {unknown_contract, <<"nope">>}}, tx_builder_contracts:get(<<"nope">>)),
    ?assertMatch({error, {unknown_argument, "fingerprint", "x"}},
                 tx_builder_fate:hash([part(<<"probe-escrow">>, "fingerprint", "x", "1")])).

http_health_and_hash() ->
    {200, Health} = http("GET", "/health", ""),
    ?assert(lists:member(<<"probe-escrow">>, maps:get(<<"contracts">>, Health))),
    Body = json:encode(#{parts => [#{contract_name => <<"probe-escrow">>, function => <<"fingerprint">>,
                                     argument => <<"t">>, value => <<"{price = 100, location = \"NLRTM\"}">>}]}),
    {200, #{<<"hash">> := <<"#", _/binary>>}} = http("POST", "/hash", binary_to_list(iolist_to_binary(Body))).

http_rejects_bad_requests() ->
    ?assertMatch({404, _}, http("GET", "/nowhere", "")),
    ?assertMatch({400, #{<<"error">> := <<"bad_json">>}}, http("POST", "/hash", "{not json")),
    ?assertMatch({400, _}, http("POST", "/events/decode", "{\"contract_name\":\"nope\",\"log\":[]}")),
    ?assertMatch({400, #{<<"error">> := <<"{missing,[contract,contract_name,function,args,caller]}">>}},
                 http("POST", "/calls", "{}")),
    ?assertMatch({400, #{<<"error">> := <<"{missing,[contract_name,args,caller]}">>}},
                 http("POST", "/creates", "{}")).

part(Name, Fun, Arg, Value) ->
    #{contract_name => Name, function => Fun, argument => Arg, value => Value}.

http(Method, Uri, Body) ->
    {proceed, [{response, {response, Headers, [Json]}}]} =
        tx_builder_http:do(#mod{method = Method, request_uri = Uri, entity_body = Body}),
    {proplists:get_value(code, Headers), json:decode(Json)}.
