"""Real PostgreSQL adapter coverage; only the explicitly named disposable test DB is allowed."""
import os
import uuid
from urllib.parse import urlparse

import pytest


@pytest.mark.parametrize("stopped", [False, True])
async def test_failed_start_preserves_stop_at_the_locked_write(stopped):
    url = os.environ.get("VEXA_MEETING_REPAIR_TEST_DATABASE_URL")
    if not url:
        pytest.skip("requires the disposable meeting-repair PostgreSQL database")
    parsed = urlparse(url)
    assert parsed.hostname == "parlor-final19-pg"
    assert parsed.path == "/vexa_meeting_repair_test"
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from meeting_api.bot_spawn.adapters import SqlAlchemyMeetingRepo
    from meeting_api.sessions import Base, Meeting, MeetingSession

    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    meeting_id = None
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        session_id = str(uuid.uuid4())
        async with sessions() as db:
            meeting = Meeting(user_id=7, platform="google_meet", platform_specific_id=session_id,
                              status="requested", data={"stop_requested": stopped})
            db.add(meeting)
            await db.flush()
            meeting_id = meeting.id
            db.add(MeetingSession(meeting_id=meeting_id, session_uid=session_id))
            await db.commit()
        result = await SqlAlchemyMeetingRepo(sessions).update_meeting_status(
            session_uid=session_id, status="failed", failure_stage="requested", completion_reason="join_failure")
        assert result["data"]["completion_reason"] == ("stopped" if stopped else "join_failure")
        assert result["data"]["stop_requested"] is stopped
    finally:
        if meeting_id is not None:
            async with sessions() as db:
                meeting = await db.get(Meeting, meeting_id)
                if meeting is not None:
                    await db.delete(meeting)
                    await db.commit()
        await engine.dispose()
