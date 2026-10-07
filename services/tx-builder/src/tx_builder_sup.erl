%%% @doc The tx-builder's top supervisor. The HTTP server runs under inets, and the
%%% contracts live in persistent_term, so it supervises nothing yet.
-module(tx_builder_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

init([]) ->
    {ok, {#{strategy => one_for_one, intensity => 5, period => 10}, []}}.
