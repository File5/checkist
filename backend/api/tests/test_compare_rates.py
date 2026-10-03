from decimal import Decimal

from django.test import SimpleTestCase

from api.rates import MAX_RATES, Conversion, RatesError, parse_rates

D = Decimal


class ParseRatesTests(SimpleTestCase):
    def test_pairs_are_parsed_as_decimal(self):
        rates = parse_rates("RUB:0.0098,KZT:0.0018")
        self.assertEqual(rates, {"RUB": D("0.0098"), "KZT": D("0.0018")})
        self.assertEqual(list(rates), ["RUB", "KZT"])
        for rate in rates.values():
            self.assertIs(type(rate), Decimal)

    def test_value_keeps_every_digit(self):
        # float дал бы 0.1000000000000000055511151231257827…
        self.assertEqual(parse_rates("RUB:0.1")["RUB"].as_tuple(), D("0.1").as_tuple())
        self.assertEqual(
            parse_rates("RUB:123456789012.123456789012")["RUB"].as_tuple(), D("123456789012.123456789012").as_tuple(),
        )

    def test_spaces_and_code_case_are_tolerated(self):
        self.assertEqual(parse_rates(" rub : 0.0098 , Kzt:2 "), {"RUB": D("0.0098"), "KZT": D("2")})

    def test_maximum_number_of_pairs(self):
        codes = [f"A{letter}A" for letter in "ABCDEFGHIJK"]
        self.assertEqual(len(parse_rates(",".join(f"{code}:1" for code in codes[:MAX_RATES]))), MAX_RATES)
        with self.assertRaisesMessage(RatesError, "Не больше 10 курсов."):
            parse_rates(",".join(f"{code}:1" for code in codes[:MAX_RATES + 1]))

    def test_zero_is_rejected(self):
        for value in ("RUB:0", "RUB:0.000", "RUB:0.0098,KZT:0"):
            with self.subTest(value=value), self.assertRaisesMessage(RatesError, "Курс должен быть больше нуля."):
                parse_rates(value)

    def test_malformed_values_are_rejected(self):
        values = [
            "RUB:-0.5", "RUB:+0.5", "RUB:abc", "RUB:", "RUB", ":0.5", "RUB:1,5", "RUB:1e5", "RUB:NaN",
            "RUB:Infinity", "RUB:.5", "RUB:5.", "RUB:0x10", "RUB:1:2", "RU:1", "RUBL:1", "Р УБ:1", "RUB=1",
            "RUB:1,", ",", "RUB:1;KZT:2", "RUB:1234567890123", "RUB:0.1234567890123", "RUB:١",
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaisesMessage(RatesError, "Ожидаются пары"):
                parse_rates(value)

    def test_repeated_currency_is_rejected(self):
        with self.assertRaisesMessage(RatesError, "Валюта указана больше одного раза."):
            parse_rates("RUB:1,rub:2")


class ConversionTests(SimpleTestCase):
    conversion = Conversion("EUR", {"RUB": D("0.1"), "KZT": D("0.0018")})

    def test_rate(self):
        self.assertEqual(self.conversion.rate("RUB"), D("0.1"))
        self.assertEqual(self.conversion.rate("EUR"), D("1"))
        self.assertIsNone(self.conversion.rate("USD"))

    def test_convert_is_exact_decimal_arithmetic(self):
        value = self.conversion.convert(D("3"), "RUB")
        self.assertIs(type(value), Decimal)
        self.assertEqual(value, D("0.3"))  # float: 0.30000000000000004
        self.assertEqual(self.conversion.convert(D("130.5882"), "KZT"), D("0.23505876"))

    def test_target_currency_is_not_converted(self):
        self.assertEqual(self.conversion.convert(D("1.3900"), "EUR"), D("1.3900"))

    def test_no_rate_or_no_price(self):
        self.assertIsNone(self.conversion.convert(D("1"), "USD"))
        self.assertIsNone(self.conversion.convert(None, "RUB"))

    def test_as_json(self):
        self.assertEqual(
            self.conversion.as_json(),
            {"target_currency": "EUR", "rates": {"RUB": "0.1", "KZT": "0.0018"}, "source": "request"},
        )
        self.assertEqual(Conversion("EUR").as_json(), {"target_currency": "EUR", "rates": {}, "source": "request"})
