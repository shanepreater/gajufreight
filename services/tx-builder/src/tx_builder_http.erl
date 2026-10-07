%%% @doc The tx-builder's HTTP API, an inets httpd callback module. JSON in and out:
%%%   GET  /health          service and contracts loaded
%%%   POST /calls           unsigned contract call + fee estimate
%%%   POST /creates         unsigned contract create + fee estimate
%%%   POST /hash            FATE blake2b hash of Sophia values
%%%   POST /events/decode   name and fields of logged events
-module(tx_builder_http).

-export([do/1]).

-include_lib("inets/include/httpd.hrl").

do(#mod{method = Method, request_uri = Uri, entity_body = Body}) ->
    {Status, Reply} = try route(Method, path(Uri), Body)
                      catch Class:Reason:Stack ->
                          logger:error("~p ~s: ~p:~p ~p", [Method, Uri, Class, Reason, Stack]),
                          {500, #{error => <<"internal error">>}}
                      end,
    Json = iolist_to_binary(json:encode(Reply)),
    {proceed, [{response, {response, [{code, Status}, {content_type, "application/json"},
                                      {content_length, integer_to_list(byte_size(Json))}],
                           [Json]}}]}.

path(Uri) -> hd(string:split(Uri, "?")).

route("GET", "/health", _) ->
    {200, #{status => <<"ok">>, contracts => tx_builder_contracts:names()}};
route("POST", "/calls", Body) ->
    reply(with_body(Body, fun(B) -> required(B, [contract, contract_name, function, args, caller], fun tx_builder_calls:call/1) end));
route("POST", "/creates", Body) ->
    reply(with_body(Body, fun(B) -> required(B, [contract_name, args, caller], fun tx_builder_calls:create/1) end));
route("POST", "/hash", Body) ->
    reply(with_body(Body, fun(#{<<"parts">> := Parts}) -> tx_builder_fate:hash([part(P) || P <- Parts]) end));
route("POST", "/events/decode", Body) ->
    reply(with_body(Body, fun(#{<<"contract_name">> := Name, <<"log">> := Log}) ->
                                  tx_builder_fate:decode_events(Name, Log)
                          end));
route(_, _, _) ->
    {404, #{error => <<"not found">>}}.

with_body(Body, Handle) ->
    try json:decode(list_to_binary(Body)) of
        Decoded when is_map(Decoded) -> Handle(Decoded);
        _ -> {error, bad_request}
    catch
        error:_ -> {error, bad_json}
    end.

%% A request missing required fields is the caller's error (400), named in the reply.
required(Body, Keys, Build) ->
    Req = request(Body),
    case [K || K <- Keys, not maps:is_key(K, Req)] of
        [] -> Build(Req);
        Missing -> {error, {missing, Missing}}
    end.

reply({ok, Result}) -> {200, Result};
reply({error, Reason}) -> {400, #{error => iolist_to_binary(io_lib:format("~0p", [Reason]))}}.

%% Only the known fields become the request map (no atoms are made from input).
request(Body) ->
    Fields = [{<<"contract">>, contract}, {<<"contract_name">>, contract_name},
              {<<"function">>, function}, {<<"args">>, args}, {<<"caller">>, caller},
              {<<"amount">>, amount}, {<<"nonce">>, nonce}, {<<"ttl">>, ttl}, {<<"gas">>, gas},
              {<<"dry_run">>, dry_run}],
    maps:from_list([{Key, value(Key, V)} || {Name, Key} <- Fields, (V = maps:get(Name, Body, undefined)) =/= undefined]).

value(function, V) -> binary_to_list(V);
value(args, Vs) -> [binary_to_list(V) || V <- Vs];
value(caller, V) -> binary_to_list(V);
value(contract, V) -> binary_to_list(V);
value(_, V) -> V.

part(#{<<"contract_name">> := Name, <<"function">> := Fun, <<"argument">> := Arg, <<"value">> := Value}) ->
    #{contract_name => Name, function => binary_to_list(Fun), argument => binary_to_list(Arg),
      value => binary_to_list(Value)}.
