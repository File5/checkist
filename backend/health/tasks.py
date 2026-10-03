from celery import shared_task


@shared_task(name="health.ping")
def ping():
    return {"message": "pong"}
