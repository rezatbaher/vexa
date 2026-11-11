"""Typed refusal survives list shaping without exposing diagnostic payloads."""
import pytest

from meeting_api.collector.projection import LIST_OMIT_KEYS, project_list_data


def test_only_the_small_typed_code_survives_and_source_data_is_unchanged():
    data = {"completion_reason": "awaiting_admission_rejected",
            "last_error": {"reason": "google_meet_join_refused: 3 of 3 knocks",
                           "error_details": "private-diagnostic" * 1000},
            "bot_logs": ["private-log"], "title": "A meeting"}
    projected = project_list_data(data)
    assert projected == {"completion_reason": "awaiting_admission_rejected",
                         "join_refusal_reason": "google_meet_join_refused", "title": "A meeting"}
    assert LIST_OMIT_KEYS.isdisjoint(projected)
    assert "last_error" in data and "bot_logs" in data


@pytest.mark.parametrize("reason,detail", [
    ("awaiting_admission_timeout", "google_meet_join_refused: a refusal"),
    ("stopped", "google_meet_join_refused: a refusal"),
    ("awaiting_admission_rejected", "A host denied the bot"),
    ("awaiting_admission_rejected", "some error mentioning google_meet_join_refused:"),
    ("awaiting_admission_rejected", None),
])
def test_other_verdicts_and_forged_metadata_are_not_relabelled(reason, detail):
    projected = project_list_data({
        "completion_reason": reason, "last_error": {"reason": detail},
        "join_refusal_reason": "untrusted-input",
    })
    assert "join_refusal_reason" not in projected and "last_error" not in projected
