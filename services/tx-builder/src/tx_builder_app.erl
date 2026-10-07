%%% @doc Starts the tx-builder: reads configuration, connects Hakuzaru to the node, loads
%%% the network's contracts, and serves HTTP on localhost.
-module(tx_builder_app).
-behaviour(application).

-export([start/2, stop/1, config/1]).

start(_Type, _Args) ->
    ok = apply_env_overrides(),
    {Host, Port} = config(node),
    ok = hz:chain_nodes([{Host, Port}]),
    ok = tx_builder_contracts:load(config(contracts_dir)),
    {ok, _} = inets:start(httpd, [{port, config(port)},
                                  {bind_address, {127, 0, 0, 1}},
                                  {server_name, "tx-builder"},
                                  {server_root, "."},
                                  {document_root, "."},
                                  {modules, [tx_builder_http]}]),
    logger:notice("tx-builder on 127.0.0.1:~b, node ~s:~b", [config(port), Host, Port]),
    tx_builder_sup:start_link().

stop(_State) ->
    ok.

config(Key) ->
    {ok, Value} = application:get_env(tx_builder, Key),
    Value.

%% Environment variables, when set, replace the application defaults.
apply_env_overrides() ->
    Overrides = [{"TX_BUILDER_PORT", port, fun list_to_integer/1},
                 {"TX_BUILDER_NODE", node, fun node/1},
                 {"TX_BUILDER_CONTRACTS", contracts_dir, fun(Dir) -> Dir end},
                 {"TX_BUILDER_FIXED_CHARGE_GAS", fixed_charge_gas, fun list_to_integer/1}],
    [application:set_env(tx_builder, Key, Parse(Value))
     || {Var, Key, Parse} <- Overrides, (Value = os:getenv(Var)) =/= false],
    ok.

node(HostPort) ->
    [Host, Port] = string:split(HostPort, ":", trailing),
    {Host, list_to_integer(Port)}.
