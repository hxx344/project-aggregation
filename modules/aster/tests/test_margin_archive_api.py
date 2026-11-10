import unittest
from unittest.mock import patch

from tests import test_pair_api as api_cases
from tests.test_pair_integration import pair_config


class MarginArchiveApiTests(unittest.TestCase):
    setUp = api_cases.PairApiTests.setUp
    login = api_cases.PairApiTests.login

    def test_authenticated_archive_and_notes_preserve_original_write_boundary(self):
        self.assertEqual(self.client.get('/api/pairs/gold/margin-archive').status_code, 401)
        self.login()
        created = self.client.post('/api/pairs', json=pair_config(margin={"absolute_reserve_enabled": True, "long_reserve": "100", "short_reserve": "200"}))
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()['pair']['margin']['short_reserve'], '200')
        original = {"pair_id": "gold", "original": {"request_id": "archived", "amount": "1", "source": "long", "destination": "short", "created_at": 100},
            "baseline": {"long": {"account_id": "test"}, "short": {"account_id": "second"}}}
        self.f.store.put('pair_margin_skipped:gold:archived', original)
        with patch.object(self.engine, 'broker', side_effect=AssertionError('review must never query or send a transfer')):
            response = self.client.get('/api/pairs/gold/margin-archive')
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn('未知', response.json()['items'][0]['basis'])
            route = '/api/pairs/gold/margin-archive/archived/notes'
            self.assertEqual(self.client.post(route, json={"note": "核对", "source": "工单"}, headers={"origin": "https://other.invalid"}).status_code, 403)
            self.assertEqual(self.client.post(route, json={"note": "核对", "source": "工单", "status": "confirmed"}).status_code, 422)
            self.assertEqual(self.client.post(route, json={"note": "核对", "source": "工单"}).status_code, 200)
        self.assertEqual(self.f.store.get('pair_margin_skipped:gold:archived'), original)
        self.assertEqual(len(self.client.get('/api/pairs/gold/margin-archive').json()['items'][0]['notes']), 1)


if __name__ == '__main__':
    unittest.main()
