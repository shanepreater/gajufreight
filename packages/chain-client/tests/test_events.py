from collections.abc import Callable

from gajufreight_chain.events import event_name, event_topic
from gajufreight_chain.models import Event, TransactionInfo


def test_topic_matches_the_booked_event_logged_on_testnet(
    load_recording: Callable[[str], object],
) -> None:
    info = TransactionInfo.model_validate(load_recording("testnet-transaction-info"))
    assert info.call_info.log[0].topics[0] == event_topic("Booked")


def test_names_the_event_from_its_first_topic() -> None:
    event = Event(address="ct_x", topics=[event_topic("RefundPaid"), 7], data="cb_")
    assert event_name(event, ["Booked", "RefundPaid"]) == "RefundPaid"


def test_unknown_or_empty_topics_name_nothing() -> None:
    assert event_name(Event(address="ct_x", topics=[1], data="cb_"), ["Booked"]) is None
    assert event_name(Event(address="ct_x", topics=[], data="cb_"), ["Booked"]) is None
