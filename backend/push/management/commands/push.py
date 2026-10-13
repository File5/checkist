import base64
import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.core.management.base import BaseCommand

from push import reasons, services


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class Command(BaseCommand):
    help = (
        "Web push. 'tick' finds the reasons of every person with a subscribed device and sends what is due, "
        "including what the quiet hours 22:00-9:00 (Asia/Almaty) held back; run it from cron every 5 minutes; "
        "prints JSON. 'keys' prints a new VAPID key pair for the environment file."
    )

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="action", required=True)
        sub.add_parser("tick", help="Find reasons and send due notifications.")
        sub.add_parser("keys", help="Generate WEBPUSH_VAPID_PUBLIC_KEY and WEBPUSH_VAPID_PRIVATE_KEY.")

    def handle(self, *args, **options):
        if options["action"] == "keys":
            key = ec.generate_private_key(ec.SECP256R1())
            public = key.public_key().public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint)
            self.stdout.write(f"WEBPUSH_VAPID_PUBLIC_KEY={_b64(public)}")
            self.stdout.write(f"WEBPUSH_VAPID_PRIVATE_KEY={_b64(key.private_numbers().private_value.to_bytes(32, 'big'))}")
            self.stdout.write("WEBPUSH_VAPID_SUBJECT=mailto:<your address>")
            return
        result = reasons.tick()
        self.stdout.write(json.dumps({"configured": services.configured(), **result}))
